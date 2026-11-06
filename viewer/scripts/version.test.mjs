// Run with: node --test scripts/
import assert from "node:assert/strict";
import { test } from "node:test";
import { changelogEntry, readVersion, writeVersion } from "./version.mjs";

const cargo = `[package]
name = "demo"
authors = ["Demo [dev]"]
version = "0.1.0"

[dependencies]
version = "9.9.9"
`;

test("Cargo.toml: the [package] version survives brackets before it", () => {
  assert.equal(readVersion("src-tauri/Cargo.toml", cargo), "0.1.0");
  const after = writeVersion("src-tauri/Cargo.toml", cargo, "0.3.0");
  assert.equal(readVersion("src-tauri/Cargo.toml", after), "0.3.0");
  assert.match(after, /version = "9\.9\.9"/);
});

test("Cargo.toml: no version under [package] reads as missing", () => {
  const text = `[package]\nname = "x"\n\n[dependencies]\nversion = "1.0.0"\n`;
  assert.equal(readVersion("src-tauri/Cargo.toml", text), undefined);
});

test("package-lock.json: both root versions move together", () => {
  const lock = JSON.stringify({ version: "0.1.0", packages: { "": { version: "0.1.0" } } });
  const after = writeVersion("package-lock.json", lock, "0.2.0");
  assert.equal(readVersion("package-lock.json", after), "0.2.0");
  assert.ok(after.endsWith("}\n"));
  const drifted = JSON.stringify({ version: "0.2.0", packages: { "": { version: "0.1.0" } } });
  assert.equal(readVersion("package-lock.json", drifted), undefined);
});

test("package.json: only the version changes", () => {
  const text = '{\n  "name": "x",\n  "version": "0.1.0"\n}\n';
  assert.equal(writeVersion("package.json", text, "1.0.0"), text.replace("0.1.0", "1.0.0"));
});

test("changelog: a release must be dated before tagging", () => {
  assert.deepEqual(changelogEntry("## [0.2.0] - Unreleased\n", "0.2.0"), {
    present: true,
    dated: false,
  });
  assert.deepEqual(changelogEntry("## [0.2.0] - 2026-11-06\n", "0.2.0"), {
    present: true,
    dated: true,
  });
  assert.equal(changelogEntry("## [0.2.10] - 2026-11-06\n", "0.2.1").present, false);
});
