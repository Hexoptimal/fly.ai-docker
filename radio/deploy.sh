#!/usr/bin/env bash
# Deploy Fly Radio to fly.io.
#
#   bash radio/deploy.sh
#
# The brain comes from PyPI (flybrain, pinned in requirements.txt) and its data files are
# downloaded during the remote build, so the staged context is only radio/ and flytalk.py
# (a few hundred KB). Mirrors flybook/worker/deploy.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/radio/model"
cp "$ROOT"/flytalk.py "$STAGE/"
cp "$ROOT"/radio/*.py "$ROOT"/radio/site.html "$ROOT"/radio/requirements.txt \
   "$ROOT"/radio/Dockerfile "$ROOT"/radio/fly.toml "$STAGE/radio/"
if [ -f "$ROOT/radio/model/readout.npz" ]; then
  cp "$ROOT"/radio/model/readout.npz "$ROOT"/radio/model/readout.json "$STAGE/radio/model/"
else
  echo "warning: radio/model/readout.npz missing -- deploying without a cached readout" \
       "(run: python radio/decode.py --cache)" >&2
fi

SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
git -C "$ROOT" diff --quiet HEAD -- radio flytalk.py 2>/dev/null || SHA="$SHA-dirty"
echo "deploying $SHA from $STAGE"
fly deploy "$STAGE" -c "$STAGE/radio/fly.toml" --remote-only --ha=false --build-arg GIT_SHA="$SHA" "$@"
