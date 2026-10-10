#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
command -v uv >/dev/null 2>&1 || { echo 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' >&2; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<12))throw Error("Node.js >=22.12 is required")'
if [ ! -x .venv/bin/python ]; then uv venv --python 3.13 .venv; fi
uv pip install --python .venv/bin/python -r requirements.lock
npm ci
npm run build
echo 'Setup complete. Connect and authorize the phone, then run sh scripts/start.sh.'
