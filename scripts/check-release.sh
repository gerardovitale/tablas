#!/usr/bin/env bash
# Checks that a release is ready to be tagged/published.
#
# Usage: bash scripts/check-release.sh <version> [--on-main <commit>]
#
#   <version>            X.Y.Z, without the leading "v"
#   --on-main <commit>   also require <commit> to be reachable from origin/main
#                        (the Publish workflow passes the tag's commit; locally,
#                        use `--on-main HEAD` before you tag)
#
# Fails unless:
#   - package.json "version" and package-lock.json's two version fields equal <version>
#   - CHANGELOG.md has a "## [<version>] - YYYY-MM-DD" heading with a real calendar date
#   - (with --on-main) the commit is on origin/main

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <version> [--on-main <commit>]" >&2
  exit 2
fi

version="$1"
shift
on_main=""
if [ "${1:-}" = "--on-main" ]; then
  on_main="${2:?--on-main needs a commit}"
  shift 2
fi
if [ $# -gt 0 ]; then
  echo "check-release: unexpected argument '$1'" >&2
  echo "usage: $0 <version> [--on-main <commit>]" >&2
  exit 2
fi

fail() { echo "check-release: $*" >&2; exit 1; }

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  fail "version '$version' is not X.Y.Z"
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pkg_version="$(node -p "require('$root/package.json').version")"
if [ "$pkg_version" != "$version" ]; then
  fail "package.json version is '$pkg_version', not '$version'"
fi

lock_versions="$(node -p "const l = require('$root/package-lock.json'); l.version + ' ' + ((l.packages || {})[''] || {}).version")"
if [ "$lock_versions" != "$version $version" ]; then
  fail "package-lock.json versions are '$lock_versions', not '$version' (run: npm install --package-lock-only)"
fi

heading="$(grep -E "^## \[$version\] - [0-9]{4}-[0-9]{2}-[0-9]{2}\$" "$root/CHANGELOG.md" | head -n 1 || true)"
if [ -z "$heading" ]; then
  fail "CHANGELOG.md has no dated '## [$version] - YYYY-MM-DD' heading"
fi
date_part="${heading##* - }"
# Reject dates that only look like one (2026-13-45). `date -d` is GNU, `date -j -f` is BSD.
if ! { date -u -d "$date_part" +%F 2>/dev/null || date -u -j -f %F "$date_part" +%F 2>/dev/null; } | grep -qx "$date_part"; then
  fail "CHANGELOG.md date '$date_part' is not a real calendar date"
fi

if [ -n "$on_main" ]; then
  git -C "$root" rev-parse --verify --quiet "origin/main" >/dev/null \
    || fail "origin/main not found (fetch it first)"
  git -C "$root" merge-base --is-ancestor "$on_main" origin/main \
    || fail "commit '$on_main' is not on origin/main"
fi

echo "check-release: $version OK (CHANGELOG dated $date_part${on_main:+, $on_main is on origin/main})"
