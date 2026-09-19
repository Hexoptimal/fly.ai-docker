#!/usr/bin/env bash
# Vercel build: the 3-D simulator, Fly Radio, Fly Roulette, the Flybook app, fly.ai compute and the static site, assembled into .vercel-out.
# Fly Radio runs the connectome in the browser and loads the Simulation's brain files (/simulation/connectome/).
set -euo pipefail
cd "$(dirname "$0")/.."
(cd world && npm run build && npm run build:radio && npm run build:roulette)
(cd flybook/web && npm run build)
rm -rf .vercel-out
mkdir -p .vercel-out/simulation .vercel-out/flybook .vercel-out/radio .vercel-out/roulette
cp -r docs/. .vercel-out/
cp -r world/dist/. .vercel-out/simulation/
cp -r world/dist-radio/assets .vercel-out/radio/
cp world/dist-radio/radio.html .vercel-out/radio/index.html
cp -r world/dist-roulette/assets .vercel-out/roulette/
cp world/dist-roulette/roulette.html .vercel-out/roulette/index.html
cp -r flybook/web/dist/. .vercel-out/flybook/
# fly.ai compute: static pages; the API runs on fly.io (mine/), brain files come from /simulation/connectome/
node mine/scripts/build-web.mjs .vercel-out/compute
