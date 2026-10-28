#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"
version="$(node -p 'JSON.parse(require("fs").readFileSync("package.json", "utf8")).version')"
bundle="grocery-cart-agent-$version"
stage="$(mktemp -d "${TMPDIR:-/tmp}/wfm-release.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/$bundle" releases
git ls-files --cached --others --exclude-standard -z > "$stage/files"

# Git supplies tracked and untracked, nonignored files. The allowlist keeps
# runtime state and historical notes out even when they were tracked earlier.
while IFS= read -r -d '' path; do
  case "$path" in
    src/*.ts|tests/*.ts|tests/fixtures/*.mjs|tests/fixtures/*.json|schemas/*.json|prompts/*.md|examples/*.json|scripts/*.sh)
      ;;
    docs/ingredients-agent.md|docs/manual-test-runbook.md|docs/release-preparation.md)
      ;;
    *)
      [[ "$path" != */* ]] || continue
      case "$path" in
        *.md|LICENSE|.gitignore|package.json|package-lock.json|tsconfig.json|eslint.config.mjs|vitest.config.ts) ;;
        *) continue ;;
      esac
      ;;
  esac
  [[ -f "$path" ]] || continue
  if [[ -L "$path" ]]; then
    echo "Refusing to package symlink: $path" >&2
    exit 1
  fi
  mkdir -p "$stage/$bundle/$(dirname "$path")"
  cp "$path" "$stage/$bundle/$path"
done < "$stage/files"

COPYFILE_DISABLE=1 tar -czf "releases/$bundle.tar.gz" -C "$stage" "$bundle"
(cd releases && shasum -a 256 "$bundle.tar.gz" > "$bundle.tar.gz.sha256")
echo "Created releases/$bundle.tar.gz and its SHA-256 checksum."
