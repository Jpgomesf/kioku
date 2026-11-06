"""Unit tests for scripts/vaults.py's text editing: run with
`python3 -m unittest discover -s tests -p 'test_*.py'`. They need no Kioku binary."""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("vaults", Path(__file__).resolve().parent.parent / "scripts" / "vaults.py")
assert SPEC and SPEC.loader
vaults = importlib.util.module_from_spec(SPEC)
sys.modules["vaults"] = vaults  # dataclasses resolve annotations through sys.modules
SPEC.loader.exec_module(vaults)

FILE = """# Kioku vaults
[[vault]]
name = "personal"
paths = ["~"]
domains = ["local", "personal/*"]
providers = ["local", "anthropic"]
default_domain = "local"

# Personal projects.
[[area]]
domain = "personal/kioku"
paths = ["~/projects/personal/mcp/kioku"]

[[area]]
domain = "personal/notes"
paths = ["~/projects/personal/notes"]

# Locked away from hosted models.
[[lock]]
domains = ["personal/notes"]
providers = ["local"]
"""


class Rendering(unittest.TestCase):
    def test_blocks_parse_back_to_what_was_asked(self) -> None:
        text = vaults.append_blocks(FILE, [
            vaults.area_block('personal/odd "name"', ["~/projects/personal/odd"]),
            vaults.vault_block("work", ["~/work"], ["github.com/acme/*"], ["work", "work/*"], ["local"], "work"),
            vaults.lock_block(["work/secret"], ["local"]),
        ])
        parsed = tomllib.loads(text)
        self.assertEqual(parsed["area"][-1], {"domain": 'personal/odd "name"', "paths": ["~/projects/personal/odd"]})
        self.assertEqual(parsed["vault"][-1]["git_remotes"], ["github.com/acme/*"])
        self.assertEqual(parsed["lock"][-1], {"domains": ["work/secret"], "providers": ["local"]})
        self.assertTrue(text.startswith(FILE.rstrip("\n")))
        self.assertTrue(text.endswith("\n") and "\n\n\n" not in text)

    def test_vault_block_leaves_out_empty_git_remotes(self) -> None:
        self.assertNotIn("git_remotes", vaults.vault_block("w", ["~/w"], [], ["w"], ["local"], "w"))


class RemovingAnArea(unittest.TestCase):
    def test_removes_only_that_block_and_keeps_the_next_blocks_comment(self) -> None:
        text = vaults.remove_area(FILE, "personal/notes")
        parsed = tomllib.loads(text)
        self.assertEqual([a["domain"] for a in parsed["area"]], ["personal/kioku"])
        self.assertEqual(len(parsed["lock"]), 1)
        self.assertIn("# Locked away from hosted models.\n[[lock]]", text)
        self.assertNotIn("\n\n\n", text)

    def test_removing_the_first_area_keeps_the_comment_above_it(self) -> None:
        text = vaults.remove_area(FILE, "personal/kioku")
        self.assertIn("# Personal projects.\n[[area]]\ndomain = \"personal/notes\"", text)

    def test_an_unknown_area_is_an_error(self) -> None:
        with self.assertRaises(SystemExit):
            vaults.remove_area(FILE, "personal/nothing")


class Patterns(unittest.TestCase):
    def test_domain_patterns_match_like_kioku(self) -> None:
        self.assertTrue(vaults.domain_matches("personal/*", "personal/kioku"))
        self.assertTrue(vaults.domain_matches("local", "local"))
        self.assertFalse(vaults.domain_matches("personal/*", "personalx"))
        self.assertTrue(vaults.domain_matches("re:fundable(/.*)?", "fundable/people-data"))
        self.assertTrue(vaults.domain_matches("a?c", "abc"))
        self.assertFalse(vaults.domain_matches("a.c", "abc"))

    def test_providers_come_from_the_vault_that_owns_the_domain(self) -> None:
        self.assertEqual(vaults.providers_for(FILE, "personal/notes"), ["local", "anthropic"])
        self.assertEqual(vaults.providers_for(FILE, "elsewhere"), [])


class Repositories(unittest.TestCase):
    def test_finds_repositories_without_looking_inside_them(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for repo in ("alpha", "group/beta", "alpha/vendor/inner", "deep/a/b/too-deep"):
                (root / repo / ".git").mkdir(parents=True)
            (root / ".hidden" / ".git").mkdir(parents=True)
            found = [str(p.relative_to(root)) for p in vaults.find_repos(root)]
            self.assertEqual(found, ["alpha", "group/beta"])

    def test_slugs_are_lowercase_and_safe(self) -> None:
        self.assertEqual(vaults.slug("promus-IDE-config"), "promus-ide-config")
        self.assertEqual(vaults.slug("My Notes (old)"), "my-notes-old")

    def test_home_paths_are_written_with_a_tilde(self) -> None:
        self.assertEqual(vaults.home_relative(Path.home() / "projects" / "x"), "~/projects/x")
        self.assertEqual(vaults.home_relative(Path("/opt/x")), "/opt/x")


if __name__ == "__main__":
    unittest.main()
