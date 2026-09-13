#!/usr/bin/env bash
# Vercel build: the 3-D simulator, the Flybook app, and the static site, assembled into .vercel-out.
set -euo pipefail
cd "$(dirname "$0")/.."
(cd world && npm run build)
(cd flybook/web && npm run build)
rm -rf .vercel-out
mkdir -p .vercel-out/simulation .vercel-out/flybook
cp -r docs/. .vercel-out/
cp -r world/dist/. .vercel-out/simulation/
cp -r flybook/web/dist/. .vercel-out/flybook/
