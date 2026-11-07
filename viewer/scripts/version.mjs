#!/usr/bin/env node
// Checks or bumps the viewer version in package.json, package-lock.json,
// src-tauri/Cargo.toml and src-tauri/tauri.conf.json.
//   node scripts/version.mjs check              exit 1 if the files differ
//   node scripts/version.mjs set 0.2.0          write 0.2.0 to all of them
//   node scripts/version.mjs tag viewer-v0.2.0  exit 1 if the tag or the changelog date is wrong
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const CARGO_VERSION_LINE = /^(version\s*=\s*")([^"]+)(".*)$/;

export const PATHS = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
];

/** Index of the `version = "..."` line inside the [package] table, or -1. */
function cargoVersionLine(lines) {
  const header = lines.findIndex((l) => l.trim() === "[package]");
  if (header < 0) return -1;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) return -1;
    if (CARGO_VERSION_LINE.test(lines[i])) return i;
  }
  return -1;
}

function writeJsonVersion(text, version) {
  return text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
}

/** The version a file declares, or undefined. */
export function readVersion(path, text) {
  if (path === "src-tauri/Cargo.toml") {
    const lines = text.split("\n");
    const i = cargoVersionLine(lines);
    return i < 0 ? undefined : CARGO_VERSION_LINE.exec(lines[i])?.[2];
  }
  const json = JSON.parse(text);
  if (path === "package-lock.json") {
    const rootPackage = json.packages?.[""]?.version;
    return json.version === rootPackage ? json.version : undefined;
  }
  return json.version;
}

/** The file's text with its version set; the caller checks it with readVersion. */
export function writeVersion(path, text, version) {
  if (path === "src-tauri/Cargo.toml") {
    const lines = text.split("\n");
    const i = cargoVersionLine(lines);
    if (i >= 0) lines[i] = lines[i].replace(CARGO_VERSION_LINE, `$1${version}$3`);
    return lines.join("\n");
  }
  if (path === "package-lock.json") {
    const lock = JSON.parse(text);
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    return `${JSON.stringify(lock, null, 2)}\n`;
  }
  return writeJsonVersion(text, version);
}

/** Whether the changelog has a `## [version]` heading, and whether it carries a date. */
export function changelogEntry(text, version) {
  const escaped = version.replace(/[.+-]/g, "\\$&");
  return {
    present: new RegExp(`^## \\[${escaped}\\]`, "m").test(text),
    dated: new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m").test(text),
  };
}

const readFile = (path) => readFileSync(join(root, path), "utf8");

function check() {
  const found = PATHS.map((path) => ({ path, version: readVersion(path, readFile(path)) }));
  const distinct = new Set(found.map((f) => f.version));
  if (distinct.size !== 1 || found.some((f) => !f.version)) {
    for (const f of found) console.error(`${f.path}: ${f.version ?? "missing or inconsistent"}`);
    fail("Versions differ. Run: node scripts/version.mjs set X.Y.Z");
  }
  const [version] = distinct;
  console.log(version);
  return version;
}

function set(version) {
  if (!version || !SEMVER.test(version)) fail(`Not a version: ${version ?? "(none)"}`);
  // Compute and verify every file before writing any, so a failure changes nothing.
  const planned = PATHS.map((path) => {
    const before = readFile(path);
    const after = writeVersion(path, before, version);
    if (readVersion(path, after) !== version) fail(`Could not set the version in ${path}`);
    return { path, before, after };
  });
  for (const { path, before, after } of planned) {
    if (after !== before) writeFileSync(join(root, path), after);
  }
  check();
  if (!changelogEntry(readFile("CHANGELOG.md"), version).present) {
    console.error(`Warning: CHANGELOG.md has no "## [${version}] - Unreleased" heading yet.`);
  }
}

function tag(name) {
  const version = check();
  if (name !== `viewer-v${version}`) fail(`Tag ${name} does not match viewer-v${version}`);
  if (!changelogEntry(readFile("CHANGELOG.md"), version).dated) {
    fail(`CHANGELOG.md needs "## [${version}] - YYYY-MM-DD" before tagging.`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, arg] = process.argv.slice(2);
  if (command === "check") check();
  else if (command === "set") set(arg);
  else if (command === "tag") tag(arg);
  else fail("Usage: version.mjs check | set X.Y.Z | tag viewer-vX.Y.Z");
}
