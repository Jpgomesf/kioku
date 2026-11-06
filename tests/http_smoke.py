#!/usr/bin/env python3
"""End-to-end checks for the HTTP transport (`kioku serve --http`).

    cargo build --features http
    python3 -I tests/http_smoke.py --binary "$PWD/target/debug/kioku" --env-file /abs/path/smoke.env

Uses the same test-storage env file as tests/mcp_smoke.py (names must contain
"smoke" or "test"). It creates two tokens with `kioku token`, starts the server
on a free loopback port, and checks authentication, DNS-rebinding defenses,
per-principal tool lists, scopes, and domain patterns. A second server runs
with a vaults file and checks that each token's provider and vault are
enforced. Stdlib only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mcp_smoke", HERE / "mcp_smoke.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

PROTOCOL = "2025-11-25"


class Failure(Exception):
    pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def make_token(binary: Path, subject: str, scopes: str, domains: str, *extra: str) -> tuple[str, str]:
    out = subprocess.run([str(binary), "token", subject, "--scopes", scopes, "--domains", domains, *extra],
                         capture_output=True, text=True, timeout=30, check=True)
    value = json.loads(out.stdout)
    return value["token"], value["access_file_entry"]


class HttpClient:
    def __init__(self, url: str, token: str | None, timeout: float):
        self.url, self.token, self.timeout = url, token, timeout
        self.session: str | None = None
        self.sequence = 0

    def post(self, message: dict, headers: dict | None = None) -> tuple[int, dict, str]:
        body = json.dumps(message).encode()
        request = urllib.request.Request(self.url, data=body, method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json, text/event-stream")
        if self.token:
            request.add_header("Authorization", f"Bearer {self.token}")
        if self.session:
            request.add_header("Mcp-Session-Id", self.session)
            request.add_header("MCP-Protocol-Version", PROTOCOL)
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, dict(response.headers), response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read().decode(errors="replace")

    def request(self, method: str, params: dict | None = None) -> dict:
        self.sequence += 1
        message = {"jsonrpc": "2.0", "id": self.sequence, "method": method, "params": params or {}}
        status, headers, text = self.post(message)
        if status != 200:
            raise Failure(f"{method} returned HTTP {status}")
        if self.session is None:
            self.session = headers.get("mcp-session-id") or headers.get("Mcp-Session-Id")
        payloads = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")] or [text]
        for payload in payloads:
            if not payload:
                continue
            value = json.loads(payload)
            if value.get("id") == self.sequence:
                if "error" in value:
                    raise Failure(f"{method} failed: {value['error'].get('message', '')[:120]}")
                return value["result"]
        raise Failure(f"{method} returned no response")

    def initialize(self) -> dict:
        result = self.request("initialize", {
            "protocolVersion": PROTOCOL, "capabilities": {},
            "clientInfo": {"name": "kioku-http-smoke", "version": "1.0.0"},
        })
        self.post({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return result

    def call(self, name: str, arguments: dict) -> tuple[str, bool]:
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        text = "\n".join(b.get("text", "") for b in result.get("content", []) if b.get("type") == "text")
        return text, bool(result.get("isError"))


def wait_for(port: int, process: subprocess.Popen, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise Failure("the HTTP server exited during startup")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    raise Failure("the HTTP server did not start listening")


def start(binary: Path, env_file: Path, access: Path, env: dict, timeout: float) -> tuple[subprocess.Popen, str]:
    port = free_port()
    server = subprocess.Popen([str(binary), "--env-file", str(env_file), "serve", "--http", f"127.0.0.1:{port}",
                               "--access-file", str(access)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
    try:
        wait_for(port, server, timeout)
    except Failure:
        stop(server)
        raise
    return server, f"http://127.0.0.1:{port}/mcp"


def stop(server: subprocess.Popen) -> None:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()


VAULTS = """
[[vault]]
name = "smoke-a"
domains = ["smoke-a", "smoke-a/*"]
providers = ["anthropic"]
default_domain = "smoke-a"

[[vault]]
name = "smoke-b"
domains = ["smoke-b", "smoke-b/*"]
providers = ["anthropic"]
default_domain = "smoke-b"
"""


def run_vaults(binary: Path, values: dict, root: Path, env: dict, timeout: float, checks: smoke.Checks) -> None:
    """With a vaults file, a token works only with a provider and a vault, and only inside that vault."""
    vaults = root / "vaults.toml"
    vaults.write_text(VAULTS, encoding="utf-8")
    vault_token, vault_entry = make_token(binary, "http-vault-a", "read,write", "*", "--provider", "anthropic", "--vault", "smoke-a")
    bare_token, bare_entry = make_token(binary, "http-bare", "read,write", "*")
    _, stray_entry = make_token(binary, "http-stray", "read", "*", "--provider", "anthropic", "--vault", "nowhere")
    access = root / "vault-access.toml"
    access.write_text(vault_entry + "\n" + bare_entry, encoding="utf-8")
    access.chmod(0o600)
    server_env = root / "vault-server.env"
    smoke.write_env({**values, "MEMORY_VAULTS_FILE": str(vaults)}, server_env)

    stray = root / "stray-access.toml"
    stray.write_text(stray_entry, encoding="utf-8")
    stray.chmod(0o600)
    refused = subprocess.run([str(binary), "--env-file", str(server_env), "serve", "--http", "127.0.0.1:1",
                              "--access-file", str(stray)], capture_output=True, text=True, timeout=60, env=env)
    checks.check("HTTP refuses to start when a token names a vault the vaults file lacks",
                 refused.returncode != 0 and "does not define" in refused.stderr)

    server, url = start(binary, server_env, access, env, timeout)
    try:
        bare = HttpClient(url, bare_token, timeout)
        bare.initialize()
        text, error = bare.call("memory_search", {"query": "anything", "domain": "smoke-a"})
        checks.check("in vault mode a token without provider and vault gets nothing",
                     error and text.startswith("refused") and "provider" in text)
        client = HttpClient(url, vault_token, timeout)
        client.initialize()
        key = "http-vault-" + uuid.uuid4().hex[:10]
        text, error = client.call("memory_save", {"key": key, "title": "HTTP vault note", "domain": "smoke-a",
                                                  "body": f"The HTTP vault smoke test saved {key} in vault smoke-a."})
        checks.check("a vault token saves in its vault", not error)
        text, error = client.call("memory_search", {"query": key})
        value = json.loads(text) if not error else {}
        checks.check("a vault token searches its whole vault", value.get("vault") == "smoke-a" and key in text)
        text, error = client.call("memory_search", {"query": key, "domain": "smoke-b"})
        checks.check("a vault token cannot reach another vault", error and text.startswith("refused"))
    finally:
        stop(server)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()
    checks = smoke.Checks()
    server = None
    workdir = tempfile.TemporaryDirectory(prefix="kioku-http-smoke-")
    try:
        binary = args.binary.resolve(strict=True)
        values = smoke.read_env(args.env_file.resolve(strict=True))
        smoke.require_test_storage(values)
        root = Path(workdir.name)
        env = {key: value for key, value in os.environ.items() if key not in smoke.CONFIG_ENV}
        env["RUST_LOG"] = "error"

        reader_token, reader_entry = make_token(binary, "http-reader", "read", "smoke")
        writer_token, writer_entry = make_token(binary, "http-writer", "read,write", "smoke,re:smoke-http-[a-z]+")
        access = root / "access.toml"
        access.write_text(reader_entry + "\n" + writer_entry, encoding="utf-8")
        access.chmod(0o600)
        values.update({"MEMORY_DEFAULT_DOMAIN": "smoke", "MEMORY_BACKGROUND_UPKEEP": "false", "MEMORY_TOOLS": "all"})
        compat = dict(values)
        # A vaults file that doesn't exist keeps the first server in compatibility mode.
        values["MEMORY_VAULTS_FILE"] = str(root / "no-vaults.toml")
        server_env = root / "server.env"
        smoke.write_env(values, server_env)

        refused = subprocess.run([str(binary), "--env-file", str(server_env), "serve", "--http", "0.0.0.0:1",
                                  "--access-file", str(access)], capture_output=True, text=True, timeout=60, env=env)
        checks.check("HTTP refuses to bind a non-loopback address", refused.returncode != 0 and "loopback" in refused.stderr)
        missing = subprocess.run([str(binary), "--env-file", str(server_env), "serve", "--http", "127.0.0.1:1"],
                                 capture_output=True, text=True, timeout=60, env=env)
        checks.check("HTTP refuses to start without an access file", missing.returncode != 0 and "access file" in missing.stderr)

        port = free_port()
        url = f"http://127.0.0.1:{port}/mcp"
        server = subprocess.Popen([str(binary), "--env-file", str(server_env), "serve", "--http", f"127.0.0.1:{port}",
                                   "--access-file", str(access)],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
        wait_for(port, server, args.timeout)

        init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "x", "version": "1"}}}
        status, headers, _ = HttpClient(url, None, args.timeout).post(init)
        checks.check("requests without a token get 401 with a Bearer challenge",
                     status == 401 and "Bearer" in headers.get("www-authenticate", headers.get("WWW-Authenticate", "")))
        status, _, _ = HttpClient(url, "kioku_" + uuid.uuid4().hex, args.timeout).post(init)
        checks.check("requests with an unknown token get 401", status == 401)
        status, _, _ = HttpClient(url, reader_token, args.timeout).post(init, {"Origin": "https://evil.example"})
        checks.check("a browser Origin that isn't allowed gets 403", status == 403)
        status, _, _ = HttpClient(url, reader_token, args.timeout).post(init, {"Host": "evil.example"})
        checks.check("a foreign Host header gets 403 (DNS rebinding)", status == 403)

        reader = HttpClient(url, reader_token, args.timeout)
        info = reader.initialize()
        checks.check("an authenticated client completes initialize", info.get("serverInfo", {}).get("name") == "kioku")
        reader_tools = {t["name"] for t in reader.request("tools/list").get("tools", [])}
        checks.check("tools/list shows a reader only read tools",
                     reader_tools == {"memory_search", "memory_get", "memory_inspect", "memory_stats", "memory_list"})

        writer = HttpClient(url, writer_token, args.timeout)
        writer.initialize()
        writer_tools = {t["name"] for t in writer.request("tools/list").get("tools", [])}
        checks.check("tools/list differs by principal", {"memory_save", "memory_feedback"} <= writer_tools
                     and "memory_retire" not in writer_tools)
        key = "http-smoke-" + uuid.uuid4().hex[:10]
        text, error = writer.call("memory_save", {
            "key": key, "title": "HTTP smoke note", "domain": "smoke",
            "body": f"The HTTP transport smoke test saved {key} through a bearer token."})
        checks.check("a writer can save in its domain", not error)
        text, error = writer.call("memory_save", {
            "key": key, "title": "Elsewhere", "domain": "work", "body": "Outside the writer's domains."})
        checks.check("a writer cannot save outside its patterns", error and text.startswith("refused"))

        text, error = reader.call("memory_search", {"query": key, "domain": "smoke", "limit": 3})
        checks.check("a reader finds what the writer saved", not error and key in text)
        text, error = reader.call("memory_save", {"key": key, "title": "x", "domain": "smoke", "body": "Readers can't write."})
        checks.check("a reader's save is refused for scope", error and "write scope" in text)
        text, error = reader.call("memory_search", {"query": key, "domain": "smoke-foreign"})
        checks.check("a reader can't search another domain", error and text.startswith("refused"))
        text, error = reader.call("memory_maintenance", {})
        checks.check("a reader can't run admin tools", error and text.startswith("refused"))
        stop(server)
        server = None
        compat.pop("MEMORY_DEFAULT_DOMAIN")
        run_vaults(binary, compat, root, env, args.timeout, checks)
    except (Failure, smoke.SmokeFailure, OSError, KeyError, ValueError, subprocess.SubprocessError) as error:
        message = str(error) if isinstance(error, (Failure, smoke.SmokeFailure)) else type(error).__name__
        print(f"FAIL after {checks.count} checks: {message}", file=sys.stderr)
        return 1
    finally:
        if server is not None:
            stop(server)
        workdir.cleanup()
    print(json.dumps({"result": "passed", "checks": checks.count, "transport": "http", "services": "real"}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
