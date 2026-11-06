#!/usr/bin/env python3
"""Edit Kioku's vaults file safely.

Every change is made on a copy of the file. The installed Kioku binary
validates the copy, the script shows where the folders it affects would now
place a session, and it prints the diff. The file is replaced, after a backup,
only with --apply; without it every command is a dry run.

  vaults.py check                         validate the vaults file
  vaults.py where FOLDER...               where sessions started in these folders land
  vaults.py add-area DOMAIN PATH...       a project area inside an existing vault (the
                                          folders must exist, unless --allow-missing)
  vaults.py add-vault NAME --path P --domain D --allow PROVIDER [--git-remote R]
                      [--default-domain D]
  vaults.py add-lock --domain D --allow PROVIDER
  vaults.py remove-area DOMAIN
  vaults.py sync-areas [--root DIR] [--prefix NAME]
                                          an area for every git repository under DIR
                                          (default ~/projects/personal) that has none

Options for every command: --file (default: $MEMORY_VAULTS_FILE, else
~/.config/kioku/vaults.toml), --provider for placement checks (default
anthropic), --apply to write.

Kioku reads the file when a session starts its server: after --apply, new
sessions see the change, and running ones must reconnect Kioku (in Claude Code,
/mcp). Changing which providers a vault lists, or a lock, needs
`bin/kioku --env-file .env repair --all` only with a hosted embedding service
(EMBEDDING_READER other than local).
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
BINARY = PROJECT / "bin" / "kioku"
ENV_FILE = PROJECT / ".env"
HEADER = re.compile(r"^\s*\[")
TIMEOUT = 20.0


# --- Rendering and editing the TOML text --------------------------------------

def toml_string(text: str) -> str:
    """A TOML basic string. JSON's escapes are a subset of TOML's."""
    return json.dumps(text, ensure_ascii=False)


def toml_list(items: list[str]) -> str:
    return "[" + ", ".join(toml_string(item) for item in items) + "]"


def home_relative(path: Path) -> str:
    """`path` written with `~` when it lies under the home folder."""
    absolute = path.expanduser().absolute()
    try:
        relative = absolute.relative_to(Path.home())
    except ValueError:
        return str(absolute)
    return "~" if relative == Path(".") else f"~/{relative}"


def area_block(domain: str, paths: list[str]) -> str:
    return f"[[area]]\ndomain = {toml_string(domain)}\npaths = {toml_list(paths)}\n"


def vault_block(name: str, paths: list[str], remotes: list[str], domains: list[str],
                providers: list[str], default_domain: str) -> str:
    lines = ["[[vault]]", f"name = {toml_string(name)}", f"paths = {toml_list(paths)}"]
    if remotes:
        lines.append(f"git_remotes = {toml_list(remotes)}")
    lines += [f"domains = {toml_list(domains)}", f"providers = {toml_list(providers)}",
              f"default_domain = {toml_string(default_domain)}"]
    return "\n".join(lines) + "\n"


def lock_block(domains: list[str], providers: list[str]) -> str:
    return f"[[lock]]\ndomains = {toml_list(domains)}\nproviders = {toml_list(providers)}\n"


def append_blocks(text: str, blocks: list[str]) -> str:
    """`text` with `blocks` appended, each after one blank line."""
    body = text.rstrip("\n")
    return body + "".join(f"\n\n{block.rstrip()}" for block in blocks) + "\n"


def remove_area(text: str, domain: str) -> str:
    """`text` without the `[[area]]` block of `domain`. Comment lines between
    that block and the next header are kept: they describe the next block."""
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    i, removed = 0, 0
    while i < len(lines):
        if lines[i].strip() != "[[area]]":
            out.append(lines[i])
            i += 1
            continue
        end = i + 1
        while end < len(lines) and not HEADER.match(lines[end]):
            end += 1
        keep_from = end
        while keep_from > i + 1 and (not lines[keep_from - 1].strip() or lines[keep_from - 1].lstrip().startswith("#")):
            keep_from -= 1
        while keep_from < end and not lines[keep_from].strip():
            keep_from += 1
        block = tomllib.loads("".join(lines[i:keep_from]))
        if block["area"][0].get("domain") != domain:
            out.append(lines[i])
            i += 1
            continue
        while out and not out[-1].strip():
            out.pop()
        if out and keep_from < end:
            out.append("\n")
        out.extend(lines[keep_from:end])
        removed += 1
        i = end
    if not removed:
        raise SystemExit(f"there is no area {domain!r} in the vaults file")
    return "".join(out).rstrip("\n") + "\n"


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9._-]+", "-", name.lower()).strip("-")


def find_repos(root: Path, depth: int = 3) -> list[Path]:
    """Git repositories under `root`, at most `depth` folders down, without
    looking inside a repository for others."""
    repos: list[Path] = []

    def walk(folder: Path, level: int) -> None:
        for child in sorted(folder.iterdir()):
            if not child.is_dir() or child.name.startswith("."):
                continue
            if (child / ".git").exists():
                repos.append(child)
            elif level < depth:
                walk(child, level + 1)

    walk(root, 1)
    return repos


def domain_matches(pattern: str, domain: str) -> bool:
    """Kioku's domain patterns: a glob with `*` and `?`, or `re:<regex>`."""
    if pattern.startswith("re:"):
        return re.fullmatch(pattern[3:], domain) is not None
    return re.fullmatch(".*".join(re.escape(part).replace(r"\?", ".") for part in pattern.split("*")), domain) is not None


def providers_for(text: str, domain: str) -> list[str]:
    """The providers of the vault whose domain patterns match `domain`."""
    for vault in tomllib.loads(text).get("vault", []):
        if any(domain_matches(pattern, domain) for pattern in vault.get("domains", [])):
            return list(vault.get("providers", []))
    return []


def check_provider(args: argparse.Namespace, allowed: list[str]) -> None:
    """Run placement checks as a provider the vault admits: one it refuses
    is never placed, which says nothing about the folders."""
    if allowed and args.provider not in allowed:
        print(f"Checking placement as provider {allowed[0]}: the vault doesn't admit {args.provider}.")
        args.provider = allowed[0]


def areas_of(text: str) -> list[tuple[str, list[Path]]]:
    return [(area["domain"], [Path(p).expanduser() for p in area.get("paths", [])])
            for area in tomllib.loads(text).get("area", [])]


# --- Asking the installed Kioku binary -----------------------------------------

def binary_env(vaults: Path, **extra: str) -> dict[str, str]:
    return {**os.environ, "MEMORY_VAULTS_FILE": str(vaults), "MEMORY_PROVIDER": "anthropic", **extra}


def validate(vaults: Path) -> str | None:
    """None when Kioku accepts the file, else its error."""
    result = subprocess.run([str(BINARY), "--env-file", str(ENV_FILE), "tools"], capture_output=True,
                            text=True, env=binary_env(vaults), timeout=60)
    if result.returncode == 0:
        return None
    lines = [line.strip() for line in result.stderr.splitlines() if line.strip()]
    return " | ".join(lines[-6:]) or f"kioku exited with {result.returncode}"


@dataclass
class Placement:
    vault: str | None = None
    area: str | None = None
    refused: str | None = None

    def describe(self) -> str:
        if self.refused:
            return f"no memory: {self.refused}"
        if self.area:
            return f'area "{self.area}" of vault "{self.vault}"'
        if self.vault:
            return f'vault "{self.vault}", at its root'
        return "no vaults (open mode)"


def place(folder: Path, vaults: Path, provider: str) -> Placement:
    """Where a session started in `folder` lands, asked from a Kioku server."""
    env = binary_env(vaults, MEMORY_PROVIDER=provider, KIOKU_SESSION_DIR=str(folder.expanduser().absolute()))
    proc = subprocess.Popen([str(BINARY), "--env-file", str(ENV_FILE), "serve"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
    try:
        def rpc(ident: int, method: str, params: dict) -> dict:
            assert proc.stdin and proc.stdout
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": ident, "method": method, "params": params}) + "\n")
            proc.stdin.flush()
            deadline = time.monotonic() + TIMEOUT
            while time.monotonic() < deadline:
                ready, _, _ = select.select([proc.stdout], [], [], deadline - time.monotonic())
                line = proc.stdout.readline() if ready else ""
                if not line:
                    break
                message = json.loads(line)
                if message.get("id") == ident:
                    return message.get("result") or {}
            raise SystemExit(f"Kioku did not answer for {folder}")

        init = rpc(1, "initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                     "clientInfo": {"name": "vaults.py", "version": "1"}})
        instructions = init.get("instructions", "")
        if m := re.search(r'this session is in area "([^"]+)" of vault "([^"]+)"', instructions):
            return Placement(vault=m.group(2), area=m.group(1))
        if m := re.search(r'this session is in vault "([^"]+)"', instructions):
            return Placement(vault=m.group(1))
        result = rpc(2, "tools/call", {"name": "memory_search", "arguments": {"query": "placement"}})
        if result.get("isError"):
            return Placement(refused=result["content"][0]["text"].removeprefix("refused: ")[:300])
        return Placement()
    finally:
        if proc.stdin:
            proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


# --- Commands ------------------------------------------------------------------

def checked_paths(paths: list[Path], allow_missing: bool) -> list[Path]:
    """`paths`, refusing ones that look like options, and missing folders
    unless `allow_missing`. Both are how a typo or a mis-split command line
    shows up."""
    for path in paths:
        text = str(path)
        if text.startswith("-") or re.search(r"\s-", text):
            raise SystemExit(f"{text!r} looks like an option, not a folder; nothing was written")
        if not allow_missing and not path.expanduser().is_dir():
            raise SystemExit(f"{home_relative(path)} is not an existing folder; create it first or pass --allow-missing")
    return paths


@dataclass
class Expect:
    """A folder and where it must land after the change."""
    folder: Path
    vault: str | None = None
    area: str | None = None


def propose(args: argparse.Namespace, new_text: str, expectations: list[Expect], notes: list[str]) -> int:
    """Validate `new_text` as the vaults file, check `expectations`, show the
    diff, and with --apply replace the file."""
    live: Path = args.file
    old_text = live.read_text(encoding="utf-8") if live.exists() else ""
    if new_text == old_text:
        print("Nothing to change.")
        return 0
    with tempfile.NamedTemporaryFile("w", suffix=".toml", delete=False, encoding="utf-8",
                                     dir=live.parent if live.parent.exists() else None) as handle:
        handle.write(new_text)
        candidate = Path(handle.name)
    try:
        candidate.chmod(0o600)
        if error := validate(candidate):
            print(f"Kioku rejects the change, so nothing was written: {error}")
            return 1
        failed = False
        for expect in expectations:
            got = place(expect.folder, candidate, args.provider)
            ok = got.vault == expect.vault if expect.area is None else got.area == expect.area
            print(f"{'ok ' if ok else 'BAD'} {home_relative(expect.folder)}: {got.describe()}")
            failed |= not ok
        if failed:
            print("A folder would not land where it should, so nothing was written.")
            return 1
        sys.stdout.writelines(difflib.unified_diff(
            old_text.splitlines(keepends=True), new_text.splitlines(keepends=True),
            fromfile=str(live), tofile=f"{live} (new)"))
        for note in notes:
            print(note)
        if not args.apply:
            print("Dry run: nothing was written. Run again with --apply to make this change.")
            return 0
        backups = live.parent / "backups"
        backups.mkdir(parents=True, exist_ok=True)
        if live.exists():
            backup = backups / f"{live.stem}-{time.strftime('%Y%m%d-%H%M%S')}.toml"
            shutil.copy2(live, backup)
            backup.chmod(0o600)
            print(f"Backed up the old file to {backup}.")
        os.replace(candidate, live)
        print(f"Wrote {live}. New sessions see the change; reconnect Kioku in running ones (/mcp in Claude Code).")
        return 0
    finally:
        candidate.unlink(missing_ok=True)


def cmd_check(args: argparse.Namespace) -> int:
    error = validate(args.file)
    print(f"{args.file}: {'valid' if error is None else error}")
    return 0 if error is None else 1


def cmd_where(args: argparse.Namespace) -> int:
    for folder in args.folders:
        print(f"{home_relative(folder)}: {place(folder, args.file, args.provider).describe()}")
    return 0


def cmd_add_area(args: argparse.Namespace) -> int:
    text = args.file.read_text(encoding="utf-8")
    folders = checked_paths(args.paths, args.allow_missing)
    paths = [home_relative(p) for p in folders]
    check_provider(args, providers_for(text, args.domain))
    return propose(args, append_blocks(text, [area_block(args.domain, paths)]),
                   [Expect(p, area=args.domain) for p in folders], [])


def cmd_add_vault(args: argparse.Namespace) -> int:
    text = args.file.read_text(encoding="utf-8") if args.file.exists() else ""
    folders = checked_paths(args.path, args.allow_missing)
    check_provider(args, args.provider_list)
    block = vault_block(args.name, [home_relative(p) for p in folders], args.git_remote, args.domain,
                        args.provider_list, args.default_domain or args.domain[0])
    return propose(args, append_blocks(text, [block]), [Expect(p, vault=args.name) for p in folders], [])


def cmd_add_lock(args: argparse.Namespace) -> int:
    text = args.file.read_text(encoding="utf-8")
    note = ("Only the providers listed may read these domains now. With a hosted embedding service "
            "(EMBEDDING_READER other than local), run `bin/kioku --env-file .env repair --all` after applying.")
    return propose(args, append_blocks(text, [lock_block(args.domain, args.provider_list)]), [], [note])


def cmd_remove_area(args: argparse.Namespace) -> int:
    text = args.file.read_text(encoding="utf-8")
    return propose(args, remove_area(text, args.domain), [], [])


def cmd_sync_areas(args: argparse.Namespace) -> int:
    text = args.file.read_text(encoding="utf-8")
    existing = areas_of(text)
    taken = {domain for domain, _ in existing}
    covered = [path.absolute() for _, paths in existing for path in paths]
    blocks, expectations = [], []
    for repo in find_repos(args.root.expanduser()):
        repo = repo.absolute()
        if any(repo == path or repo.is_relative_to(path) for path in covered):
            continue
        domain = f"{args.prefix}/{slug(repo.name)}"
        if domain in taken:
            print(f"skip {home_relative(repo)}: area {domain} already exists for another folder")
            continue
        taken.add(domain)
        blocks.append(area_block(domain, [home_relative(repo)]))
        expectations.append(Expect(repo, area=domain))
    if not blocks:
        print(f"Every repository under {home_relative(args.root)} already has an area.")
        return 0
    return propose(args, append_blocks(text, blocks), expectations, [])


def main() -> int:
    default_file = Path(os.environ.get("MEMORY_VAULTS_FILE") or "~/.config/kioku/vaults.toml").expanduser()
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--file", type=Path, default=default_file, help="the vaults file (default: %(default)s)")
    common.add_argument("--provider", default="anthropic", help="provider for placement checks (default: anthropic)")
    common.add_argument("--apply", action="store_true", help="write the change; without it, a dry run")
    common.add_argument("--allow-missing", action="store_true",
                        help="accept folders that don't exist yet in add-area and add-vault")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check", parents=[common]).set_defaults(run=cmd_check)
    where = commands.add_parser("where", parents=[common])
    where.add_argument("folders", nargs="+", type=Path)
    where.set_defaults(run=cmd_where)
    add_area = commands.add_parser("add-area", parents=[common])
    add_area.add_argument("domain")
    add_area.add_argument("paths", nargs="+", type=Path)
    add_area.set_defaults(run=cmd_add_area)
    add_vault = commands.add_parser("add-vault", parents=[common])
    add_vault.add_argument("name")
    add_vault.add_argument("--path", action="append", type=Path, required=True)
    add_vault.add_argument("--git-remote", action="append", default=[])
    add_vault.add_argument("--domain", action="append", required=True)
    add_vault.add_argument("--allow", dest="provider_list", action="append", required=True,
                           help="a model provider the vault admits (repeat)")
    add_vault.add_argument("--default-domain")
    add_vault.set_defaults(run=cmd_add_vault)
    add_lock = commands.add_parser("add-lock", parents=[common])
    add_lock.add_argument("--domain", action="append", required=True)
    add_lock.add_argument("--allow", dest="provider_list", action="append", required=True,
                          help="a model provider that may still read these domains (repeat)")
    add_lock.set_defaults(run=cmd_add_lock)
    remove = commands.add_parser("remove-area", parents=[common])
    remove.add_argument("domain")
    remove.set_defaults(run=cmd_remove_area)
    sync = commands.add_parser("sync-areas", parents=[common])
    sync.add_argument("--root", type=Path, default=Path("~/projects/personal"))
    sync.add_argument("--prefix", default="personal", help="domain prefix of the new areas (default: personal)")
    sync.set_defaults(run=cmd_sync_areas)
    args = parser.parse_args()
    if not BINARY.exists():
        print(f"Kioku is not installed at {BINARY}; run `make install` first.", file=sys.stderr)
        return 1
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
