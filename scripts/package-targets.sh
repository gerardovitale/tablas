#!/usr/bin/env bash
set -euo pipefail

# Builds one .vsix per platform target.
#
# Why this exists: @duckdb/node-bindings-<platform-arch> is a native binding.
# `npm install` only fetches the dev machine's matching package, and a plain
# `vsce package --target <x>` does NOT prune node_modules by target on its own
# (verified empirically: packaging with --target linux-x64 while both darwin-arm64
# and linux-x64 bindings were present in node_modules shipped BOTH, ~180MB) — see
# the Packaging note in CLAUDE.md's DuckDB section. So for each target this script
# swaps in exactly that platform's @duckdb/node-bindings-<arch> package before
# packaging, and restores the dev machine's own package when done.
#
# Only targets DuckDB actually publishes bindings for are built (no win32-ia32,
# no linux-armhf — @duckdb/node-bindings has no variant for either).
#
# This only verifies packaging (file layout / size). It does NOT prove the
# resulting .vsix works on that platform — a native .node built for linux-x64
# can't be loaded on this macOS dev machine. Test on real target hosts (or CI
# runners) before publishing.
#
# No associative arrays (macOS ships bash 3.2, which lacks `declare -A`) —
# target -> @duckdb/node-bindings suffix lookup is a case statement instead.
#
# Usage: scripts/package-targets.sh [--skip-build] [-o <out-dir>] [target ...]
#   --skip-build   skip `npm run compile:production` (reuse existing dist/)
#   -o <out-dir>   output directory (default: dist-vsix)
#   target ...     only build these targets (default: all listed below)

cd "$(dirname "$0")/.."

ALL_TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64 alpine-x64 alpine-arm64 win32-x64 win32-arm64"

duckdb_suffix_for() {
  case "$1" in
    darwin-arm64) echo "darwin-arm64" ;;
    darwin-x64) echo "darwin-x64" ;;
    linux-x64) echo "linux-x64" ;;
    linux-arm64) echo "linux-arm64" ;;
    alpine-x64) echo "linux-x64-musl" ;;
    alpine-arm64) echo "linux-arm64-musl" ;;
    win32-x64) echo "win32-x64" ;;
    win32-arm64) echo "win32-arm64" ;;
    *) return 1 ;;
  esac
}

OUT_DIR="dist-vsix"
SKIP_BUILD=0
TARGETS_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    -o) OUT_DIR="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) TARGETS_ARG="$TARGETS_ARG $1"; shift ;;
  esac
done

if [[ -n "$TARGETS_ARG" ]]; then
  TARGETS="$TARGETS_ARG"
  for t in $TARGETS; do
    if ! duckdb_suffix_for "$t" >/dev/null; then
      echo "Unknown/unsupported target: $t" >&2
      echo "Supported: $ALL_TARGETS" >&2
      exit 1
    fi
  done
else
  TARGETS="$ALL_TARGETS"
fi

VERSION=$(node -pe "require('./package.json').version")
DUCKDB_VERSION=$(node -pe "require('./node_modules/@duckdb/node-bindings/package.json').version")

echo "tablas $VERSION — packaging targets: $TARGETS"
echo "duckdb bindings version: $DUCKDB_VERSION"
mkdir -p "$OUT_DIR"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  npm run compile:production
fi

restore_dev_bindings() {
  echo ""
  echo "Restoring dev machine's own @duckdb/node-bindings-* package..."
  rm -rf node_modules/@duckdb/node-bindings-*
  npm install --no-save >/dev/null 2>&1 || true
}
trap restore_dev_bindings EXIT

BUILT=""
for target in $TARGETS; do
  suffix="$(duckdb_suffix_for "$target")"
  pkg="@duckdb/node-bindings-${suffix}@${DUCKDB_VERSION}"
  echo ""
  echo "=== $target ($pkg) ==="
  rm -rf node_modules/@duckdb/node-bindings-*
  # --force: npm refuses a foreign os/cpu package by default; we want it anyway.
  npm install --no-save --force "$pkg"
  # npm's install also re-resolves the lockfile and silently restores the dev
  # machine's own (host-platform-matching) binding alongside the forced one —
  # prune everything except the target we actually want.
  for d in node_modules/@duckdb/node-bindings-*; do
    [[ "$(basename "$d")" == "node-bindings-${suffix}" ]] || rm -rf "$d"
  done
  out_file="$OUT_DIR/tablas-${VERSION}-${target}.vsix"
  npx vsce package --target "$target" -o "$out_file"
  BUILT="$BUILT $out_file"
done

echo ""
echo "Built package(s):"
ls -lh $BUILT
