# Releasing Kioku Viewer

## Tags

A viewer release is a tag `viewer-vX.Y.Z` on `main`, for example `viewer-v0.1.0`. The
`viewer-v` prefix keeps viewer releases apart from the `kioku` crate's own tags.

## One version in four files

The version lives in `package.json`, `package-lock.json` (its root entries),
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. `scripts/version.mjs` keeps them
equal, and `node --test scripts/` tests it:

```sh
node scripts/version.mjs check              # prints the version, fails if the files differ
node scripts/version.mjs set 0.2.0          # writes 0.2.0 to all four, or to none on error
node scripts/version.mjs tag viewer-v0.2.0  # fails on a wrong tag or an undated changelog entry
```

CI runs `check` on every build and `tag` on release tags. The app reads its version from
`CARGO_PKG_VERSION`, so `get_app_info` always reports what was built.

## Cutting a release

1. Add `## [X.Y.Z] - Unreleased` to the top of `CHANGELOG.md`, with a title line and the
   changes as bullets. The app shows these notes, parsed at compile time, and a test fails
   if the newest entry is not the package version.
2. `node scripts/version.mjs set X.Y.Z` (it warns if step 1 is missing), then run
   `cargo update -p kioku-viewer --offline` in `src-tauri/` so `Cargo.lock` matches.
3. When the release is ready, replace `Unreleased` with the date (`YYYY-MM-DD`). The `tag`
   check in CI fails on an undated entry.
4. Run `make viewer-check` from the repo root, open a PR and merge it.
5. Tag `main` and push the tag:

   ```sh
   git tag -a viewer-vX.Y.Z -m "Kioku Viewer X.Y.Z"
   git push origin viewer-vX.Y.Z
   ```

## The macOS bundle

The `viewer` workflow builds on a macOS runner for every tag whose commit is on `main`:

```sh
npm ci
npm run tauri build -- --bundles app,dmg
```

The output lands in `src-tauri/target/release/bundle/` (`macos/*.app`, `dmg/*.dmg`). The
build job then packs the `.app` into an unsigned `*.app.tar.gz`, the updater archive.

The build job has a read-only token, no caches and no secrets: it runs every npm script and
every crate's `build.rs`, so a compromised dependency must not see the updater key. A
separate `sign` job, in the `release` environment, checks nothing out; it downloads the
archive and runs only the pinned signer (`npx --yes @tauri-apps/cli@2.12.4 signer sign`)
with the key in that one step. The trade-off: the signer is fetched from npm at sign time rather than from the lockfile, so
bump its version here and in the workflow together. A separate `publish` job, which runs no
npm or cargo code, holds the write token: it creates a GitHub Release for the tag with
`--latest=false` and attaches the `.dmg`, the `.app.tar.gz`, its `.sig` and a `latest.json`.
It also uploads `latest.json` to a rolling `viewer-latest` release. That file is what the
updater reads:

```json
{
  "version": "X.Y.Z",
  "notes": "See CHANGELOG.md",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of the .sig file>",
      "url": "https://github.com/Jpgomesf/kioku/releases/download/viewer-vX.Y.Z/Kioku.Viewer.app.tar.gz"
    }
  }
}
```

The updater does not use `releases/latest/download/...`: GitHub's "latest" release is one
per repo, and the `kioku` crate's releases would take it over and break every update check.
`viewer-latest` belongs to the viewer alone.

The `publish` job stays off until the repo variable `VIEWER_PUBLISH` is `true`. Until then,
build locally and attach the files by hand with `gh release create --latest=false`.

## Later: updater keys

1. `npx tauri signer generate -w ~/.tauri/kioku-viewer.key`. Keep the private key and its
   password out of the repo.
2. In `tauri.conf.json`, put the public key under `plugins.updater.pubkey`, with the endpoint
   `https://github.com/Jpgomesf/kioku/releases/download/viewer-latest/latest.json`. Add the
   updater plugin.
3. Create the `release` environment (below) and add `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as its environment secrets, not repo secrets. Only
   the workflow's `sign` job reads them; never pass them to the build job.
4. Make `check_for_updates` call the updater instead of returning "not configured", and set
   the repo variable `VIEWER_PUBLISH` to `true`.

## The release environment

`sign` and `publish` run in a GitHub environment named `release`, so the signing key and
the write step are reachable only from a release tag. Create it once in GitHub settings:

1. Settings, Environments, New environment, name `release`.
2. Under Deployment branches and tags, pick Selected branches and tags and add the tag
   rule `viewer-v*`. That rule limits tag names, not commits, so also add a tag ruleset
   (Settings, Rules) so only maintainers can create `viewer-v*` tags. Both are required.
3. Add yourself as a required reviewer, so each publish waits for your approval. This is
   required too: it is where you check that the tag points at the commit you meant.
4. Add the two `TAURI_SIGNING_*` secrets here, and delete any repo-level copies. Do this
   before setting `VIEWER_PUBLISH` to `true`: a job in any environment can read
   repo-level secrets, so leftover copies would let `sign` run outside these rules.

These settings are the real control over what gets signed and published. The workflow
also has a `tag-on-main` job: a tag whose commit is not on `main` fails there, before the
build starts. It guards against tagging the wrong commit by mistake, not against a
writer, because the workflow that runs is the one in the tagged commit, which can drop
the job. If the environment does not exist yet, GitHub creates an empty one on the first
run. Once the repo-level copies of the secrets are deleted, that empty environment has
none, so `sign` fails rather than signing.

## Later: signing and notarization

Unsigned builds open only after a right-click and Open. To sign and notarize:

1. Get a Developer ID Application certificate and export it as a `.p12`.
2. Add the secrets `APPLE_CERTIFICATE` (base64 of the `.p12`), `APPLE_CERTIFICATE_PASSWORD`,
   `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and
   `APPLE_TEAM_ID`.
3. Pass them to the `tauri build` step. Tauri signs, notarizes and staples when they are set.
4. Check a downloaded build with `spctl -a -vv "Kioku Viewer.app"`.
