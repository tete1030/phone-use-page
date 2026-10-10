#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<12))throw Error("Node.js >=22.12 is required")'
setup_python=${SETUP_PYTHON:-python3}
if [ ! -x .venv/bin/python ]; then
  "$setup_python" -c 'import sys; assert sys.version_info >= (3, 11), "Python >=3.11 is required"'
  if command -v uv >/dev/null 2>&1; then
    uv venv --python "$setup_python" .venv
  else
    "$setup_python" -m venv .venv
  fi
fi
.venv/bin/python -c 'import sys; assert sys.version_info >= (3, 11), "Python >=3.11 is required"'
if command -v uv >/dev/null 2>&1; then
  uv pip install --python .venv/bin/python -r requirements.lock
else
  if ! .venv/bin/python -m pip --version >/dev/null 2>&1; then .venv/bin/python -m ensurepip --upgrade; fi
  .venv/bin/python -m pip install -r requirements.lock
fi
npm ci
npm run build
echo 'Setup complete. Connect and authorize the phone, then run sh scripts/start.sh.'
