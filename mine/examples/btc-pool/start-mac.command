#!/bin/bash
# fly.ai compute: Bitcoin pool mining. Double-click to start (or run: bash start-mac.command); see README.md.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo; echo "Node.js isn't installed. Download the LTS version from https://nodejs.org, install it, then start this again."; echo
  read -n 1 -s -r -p "Press any key to close"; exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)"; then
  echo; echo "This needs Node.js 22.18 or newer. Download the LTS version from https://nodejs.org, install it, then start this again."; echo
  read -n 1 -s -r -p "Press any key to close"; exit 1
fi
node start.ts
read -n 1 -s -r -p "Press any key to close"
