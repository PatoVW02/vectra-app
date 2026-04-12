#!/bin/bash
# Builds and publishes all three architecture targets to GitHub, then
# re-uploads each build's latest-mac.yml as an arch-specific file so
# the auto-updater can route each installed build to the right ZIP.
#
# Resulting GitHub release assets:
#   latest-mac.yml        — universal (backward compat for older installs)
#   universal-mac.yml     — universal builds check this
#   arm64-mac.yml         — arm64-only builds check this
#   x64-mac.yml           — x64-only builds check this

set -e

# Load GH_TOKEN from .env.local
set -a; . ./.env.local; set +a

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"
TMP=$(mktemp -d)
trap 'rm -rf "${TMP}"' EXIT

echo "▶ Building Vectra ${TAG}"

# Build renderer/main JS once (arch-independent)
npm run build

# ── arm64 ─────────────────────────────────────────────────────────────────────
echo "▶ Building scanner (arm64)"
npm run build:scanner
echo "▶ Packaging + publishing arm64"
electron-builder --arm64 --publish always
echo "▶ Saving arm64-mac.yml"
gh release download "${TAG}" --pattern "latest-mac.yml" -O "${TMP}/arm64-mac.yml" --clobber
gh release upload "${TAG}" "${TMP}/arm64-mac.yml" --clobber

# ── x64 ───────────────────────────────────────────────────────────────────────
echo "▶ Building scanner (x64)"
npm run build:scanner:x64
echo "▶ Packaging + publishing x64"
electron-builder --x64 --publish always
echo "▶ Saving x64-mac.yml"
gh release download "${TAG}" --pattern "latest-mac.yml" -O "${TMP}/x64-mac.yml" --clobber
gh release upload "${TAG}" "${TMP}/x64-mac.yml" --clobber

# ── universal (last — final latest-mac.yml stays as universal) ────────────────
echo "▶ Building scanner (universal)"
npm run build:scanner:universal
echo "▶ Packaging + publishing universal"
electron-builder --universal --publish always
echo "▶ Saving universal-mac.yml"
gh release download "${TAG}" --pattern "latest-mac.yml" -O "${TMP}/universal-mac.yml" --clobber
gh release upload "${TAG}" "${TMP}/universal-mac.yml" --clobber

echo ""
echo "✓ Release ${TAG} published"
echo "  latest-mac.yml       → universal (backward compat)"
echo "  universal-mac.yml    → universal builds"
echo "  arm64-mac.yml        → Apple Silicon builds"
echo "  x64-mac.yml          → Intel builds"
