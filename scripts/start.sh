#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
test -f dist/server.js || { echo 'Run sh scripts/setup.sh first.' >&2; exit 1; }
exec node --env-file-if-exists=.env dist/server.js
