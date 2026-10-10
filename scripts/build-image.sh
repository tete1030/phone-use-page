#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
umask 077
mkdir -p .local
console_revision=$(python3 - <<'PY'
from pathlib import Path
import hashlib
h=hashlib.sha256()
files=[Path(p) for p in ['Dockerfile','.dockerignore','package.json','package-lock.json','requirements.lock','tsconfig.json','scripts/build.mjs','scripts/container-entrypoint.sh','scripts/healthcheck.mjs']]
for directory in ['src','web','bridge','tests','vendor']:
    files.extend(p for p in Path(directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc')
for p in sorted(files):
    h.update(str(p).encode());h.update(b'\0');h.update(p.read_bytes());h.update(b'\0')
print(h.hexdigest()[:12])
PY
)
console_image=${1:-android-console:$console_revision}
docker build --pull --build-arg "APP_REVISION=$console_revision" -t "$console_image" .
printf '%s\n' "$console_image" > .local/built-image
printf 'Built %s (revision %s)\n' "$console_image" "$console_revision"
