#!/bin/bash
# Builds and publishes all macOS release variants locally, then pushes the
# version tag so GitHub Actions can build and publish the Windows installer.

set -e

# Load GH_TOKEN from .env.local
set -a; . ./.env.local; set +a

VERSION=$(node -p "require('./package.json').version")
TAG="v${VERSION}"

echo "▶ Building Nerion ${TAG} for macOS"

npm run release:all

if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "✗ Git tag ${TAG} already exists locally"
  exit 1
fi

echo "▶ Pushing tag ${TAG} to trigger Windows CI release"
git tag "${TAG}"
git push origin "${TAG}"

echo ""
echo "✓ macOS release ${TAG} published"
echo "  arm64, x64, and universal macOS artifacts uploaded."
echo "  Windows NSIS build will be produced by GitHub Actions on the tag push."
