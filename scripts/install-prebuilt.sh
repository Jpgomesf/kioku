#!/usr/bin/env bash
# Install the macOS (Apple Silicon) binary that CI builds from main, instead of
# compiling it (make install-prebuilt). The build must be of this checkout's
# commit, because bin/kioku and the scripts beside it change together; pass
# --any-commit to install it anyway. The previous binary is kept as
# bin/kioku.previous.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${KIOKU_REPO:-Jpgomesf/kioku}"
TAG="${KIOKU_RELEASE_TAG:-main-build}"
ASSET="kioku-aarch64-apple-darwin.tar.gz"

any_commit=false
for arg in "$@"; do
  case "$arg" in
    --any-commit) any_commit=true ;;
    *) printf 'Unknown argument %s; the only option is --any-commit.\n' "$arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)/$(uname -m)" != "Darwin/arm64" ]]; then
  printf 'Prebuilt binaries are for macOS on Apple Silicon only; run make install to compile.\n' >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  printf 'This needs the GitHub CLI (gh); or run make install to compile.\n' >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
gh release download "$TAG" --repo "$REPO" --dir "$work" \
  --pattern "$ASSET" --pattern COMMIT --pattern SHA256SUMS
if ! (cd "$work" && shasum -a 256 -c SHA256SUMS >/dev/null); then
  printf 'The download does not match its checksums; nothing was installed.\n' >&2
  exit 1
fi

built="$(tr -d '[:space:]' < "$work/COMMIT")"
here="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
if [[ "$built" != "$here" && "$any_commit" != true ]]; then
  printf 'The latest build is of %s, but this checkout is at %s.\n' "${built:0:8}" "${here:0:8}" >&2
  printf 'Pull main and retry, run make install to compile this commit, or pass --any-commit.\n' >&2
  exit 1
fi

tar -xzf "$work/$ASSET" -C "$work"
# Run the new binary before it replaces the old one.
if ! version="$("$work/kioku" --version)"; then
  printf 'The downloaded binary does not run; nothing was installed.\n' >&2
  exit 1
fi
mkdir -p "$PROJECT_DIR/bin"
if [[ -x "$PROJECT_DIR/bin/kioku" ]]; then
  cp -p "$PROJECT_DIR/bin/kioku" "$PROJECT_DIR/bin/kioku.previous"
fi
install -m 755 "$work/kioku" "$PROJECT_DIR/bin/kioku"
printf 'Installed %s, built from %s. The previous binary is bin/kioku.previous.\n' "$version" "${built:0:8}"
