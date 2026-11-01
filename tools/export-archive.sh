#!/usr/bin/env bash
#
# Build a privacy-clean source archive of dsh-codeflow-canvas.
#
# Why this exists: the DSH Host's shell tool is blocked on some Windows machines
# when the PowerShell execution policy forbids `prepare-workspace.ps1`. That
# prevents the agent from running `zip`, so the same packaging steps are kept
# here as a small, auditable launcher.
#
# Usage (macOS / Linux):
#   bash tools/export-archive.sh [output.zip]
#
# Default output: ../dsh-codeflow-canvas-1.2.0.zip (next to the plugin folder).
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-../dsh-codeflow-canvas-1.2.0.zip}"
case "$OUT" in
  /*) : ;;
  *) OUT="$(pwd)/$OUT" ;;
esac

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/codeflow-export.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/dsh-codeflow-canvas"

# Copy only the shippable source. Runtime state, VCS metadata and caches never
# enter the archive.
export COPYFILE_DISABLE=1
tar -C . \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./flow-projects' \
  --exclude='*.log' \
  --exclude='*.zip' \
  --exclude='*.tar' \
  --exclude='.DS_Store' \
  --exclude='*/.DS_Store' \
  -cf - . | tar -C "$STAGE/dsh-codeflow-canvas" -xf -

# Defensive cleanup for nested copies.
find "$STAGE" -type d \( -name .git -o -name node_modules -o -name flow-projects \) -prune -exec rm -rf {} + 2>/dev/null || true
find "$STAGE" -type f \( -name '.DS_Store' -o -name '._*' -o -name '*.log' -o -name '*.zip' -o -name '*.tar' \) -delete 2>/dev/null || true

# Privacy gate: the archive must not contain the current HOME path, the local
# account name, or the developer path from the original report. The source only
# uses generic examples (`/Users/you`, `/Users/me`).
for needle in "$HOME" "/Users/$(id -un)"; do
  [ -n "$needle" ] || continue
  if grep -RIlF -- "$needle" "$STAGE" >/dev/null 2>&1; then
    echo "privacy: refusing to package: found '$needle' in the staged source" >&2
    exit 1
  fi
done

( cd "$STAGE" && zip -qrX "$OUT" dsh-codeflow-canvas )
echo "wrote $OUT"
