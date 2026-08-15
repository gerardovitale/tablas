#!/usr/bin/env bash
# install-local.sh — build, package, and install Tablas into VS Code
# Usage: bash scripts/install-local.sh [--skip-tests] [--keep-vsix] [--publish-help]

set -euo pipefail

# ── Flags ────────────────────────────────────────────────────────────────────
SKIP_TESTS=false
KEEP_VSIX=false
PUBLISH_HELP=false

for arg in "$@"; do
  case "$arg" in
    --skip-tests)   SKIP_TESTS=true ;;
    --keep-vsix)    KEEP_VSIX=true ;;
    --publish-help) PUBLISH_HELP=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# ── Publishing guide ─────────────────────────────────────────────────────────
if $PUBLISH_HELP; then
  cat <<'EOF'

╔══════════════════════════════════════════════════════════════════╗
║           Tablas — VS Code Marketplace Publishing Guide          ║
╚══════════════════════════════════════════════════════════════════╝

Prerequisites (one-time setup):
  1. Create a publisher account at https://marketplace.visualstudio.com/manage
     Publisher ID must match package.json → "publisher": "gerardovitale"

  2. Generate a Personal Access Token (PAT):
     Azure DevOps → User Settings → Personal Access Tokens
     Scope: Marketplace → Manage

  3. Log in once:
       vsce login gerardovitale
     (paste your PAT when prompted — stored in system keychain)

To publish a new version:
  a. Bump version in package.json (e.g. 0.1.0 → 0.2.0)
  b. Update CHANGELOG.md (required by vsce)
  c. Run:
       npm run compile:production
       vsce publish
     Or publish a pre-built vsix:
       vsce publish --packagePath tablas-0.2.0.vsix

Marketplace assets to prepare before first publish:
  - README.md        (shown on the extension's Marketplace page)
  - CHANGELOG.md     (required by vsce)
  - icon.png         (128×128 PNG recommended)
  These should live at the project root.

EOF
  exit 0
fi

# ── Helpers ──────────────────────────────────────────────────────────────────
log()  { echo "▶ $*"; }
ok()   { echo "✓ $*"; }
fail() { echo "✗ $*" >&2; exit 1; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
log "Checking prerequisites..."

for cmd in node npm code; do
  command -v "$cmd" &>/dev/null || fail "'$cmd' not found on PATH"
done

if ! command -v vsce &>/dev/null; then
  log "vsce not found — installing globally..."
  npm install -g @vscode/vsce || fail "Failed to install vsce"
fi

ok "Prerequisites satisfied"

# ── Resolve project root (script may be called from anywhere) ─────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ── Tests ─────────────────────────────────────────────────────────────────────
if $SKIP_TESTS; then
  log "Skipping tests (--skip-tests)"
else
  log "Running tests..."
  npm test || fail "Tests failed — fix errors before installing"
  ok "Tests passed"
fi

# ── Production build ──────────────────────────────────────────────────────────
log "Building production bundle..."
npm run compile:production || fail "Production build failed"
ok "Build complete"

# ── Package ───────────────────────────────────────────────────────────────────
log "Packaging extension..."
vsce package || fail "vsce package failed"

# Locate the generated .vsix (newest match in project root)
VSIX="$(ls -t tablas-*.vsix 2>/dev/null | head -1)"
[[ -n "$VSIX" ]] || fail "No .vsix file found after packaging"
ok "Packaged → $VSIX"

# ── Install ───────────────────────────────────────────────────────────────────
log "Installing $VSIX into VS Code..."
code --install-extension "$VSIX" || fail "code --install-extension failed"
ok "Extension installed"

# ── Cleanup ───────────────────────────────────────────────────────────────────
if $KEEP_VSIX; then
  ok "Keeping $VSIX (--keep-vsix)"
else
  rm -f "$VSIX"
  ok "Cleaned up $VSIX"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "Done! Reload VS Code (Developer: Reload Window) and open a .csv file to verify."
