#!/usr/bin/env python3
"""Check indexed Git blobs, never local runtime data, before public publication."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def git(*args):
    return subprocess.check_output(['git', *args])


root = Path(git('rev-parse', '--show-toplevel').decode().strip())
os.chdir(root)
private_markers = root / '.local/publication-private-markers.json'
markers = json.loads(private_markers.read_text()).get('markers', []) if private_markers.exists() else []
blocked_dirs = {'.local', '.venv', 'node_modules', 'dist', 'deploy', 'private', 'secrets', '.android', '__pycache__'}
blocked_extensions = {'.pem', '.key', '.p12', '.pfx', '.crt', '.pcap', '.pcapng', '.har', '.log', '.sqlite', '.db', '.png', '.jpg', '.jpeg', '.h264', '.mp4', '.webm', '.zip', '.gz'}
# Replacing a reviewed screenshot requires another visual review and hash update.
reviewed_images = {'docs/screenshots/console.png': 'f7f309abcc7d67be020b894d2b56ca5e411b72916e488da25eba4a61fc9ea1ba'}
patterns = {
    'private-key': r'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----',
    'github-token': r'(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})',
    'aws-key': r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
    'credential-url': r'https?://[^\s/@:]+:[^\s/@]+@',
    'personal-home-path': r'/(?:home|Users)/(?!node(?:/|\b))[^/\s]+/(?:Documents|\.codex|\.ssh|Desktop|Downloads)',
}
failures = []
count = 0
for record in git('ls-files', '--stage', '-z').split(b'\0'):
    if not record:
        continue
    meta, filename = record.split(b'\t', 1)
    mode, oid, stage = meta.split()
    name = filename.decode()
    path = Path(name)
    if stage != b'0':
        failures.append((name, 0, 'unmerged-index'))
        continue
    if mode not in (b'100644', b'100755'):
        failures.append((name, 0, 'non-regular-file'))
        continue
    private_name = (path.name.startswith('.env') and path.name != '.env.example') or (
        path.name.startswith('compose.env') and path.name != 'compose.env.example') or path.name.startswith('adbkey')
    if blocked_dirs.intersection(path.parts) or private_name or (path.suffix.lower() in blocked_extensions and name not in reviewed_images):
        failures.append((name, 0, 'private-path'))
        continue
    blob = git('cat-file', 'blob', oid.decode())
    count += 1
    if name in reviewed_images:
        if not blob.startswith(b'\x89PNG\r\n\x1a\n') or hashlib.sha256(blob).hexdigest() != reviewed_images[name]:
            failures.append((name, 0, 'unreviewed-documentation-image'))
        continue
    if name == 'vendor/scrcpy-server-v3.3.3':
        if hashlib.sha256(blob).hexdigest() != '7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0':
            failures.append((name, 0, 'unverified-vendor-binary'))
        continue
    try:
        text = blob.decode('utf-8')
    except UnicodeDecodeError:
        failures.append((name, 0, 'unreviewed-binary'))
        continue
    for line_number, line in enumerate(text.splitlines(), 1):
        for label, pattern in patterns.items():
            if re.search(pattern, line):
                failures.append((name, line_number, label))
        for marker in markers:
            value = marker.get('value', '')
            if value and (value in line or json.dumps(value)[1:-1] in line):
                failures.append((name, line_number, 'private-environment-or-secret'))
        if re.search(r'^(?:export\s+)?ANDROID_SERIAL\s*=\s*[^#\s]+', line) and 'YOUR_' not in line and 'fixture' not in line.lower():
            failures.append((name, line_number, 'hardcoded-device-serial'))
        if re.search(r'ANDROID_SERIAL\s*[:=]\s*["\'][A-Za-z0-9:._-]{6,}["\']', line) and 'fixture' not in line.lower():
            failures.append((name, line_number, 'hardcoded-device-serial'))

if failures:
    for filename, line, label in failures:
        print(f'{filename}:{line}: {label}', file=sys.stderr)
    raise SystemExit(f'Publication blocked: {len(failures)} finding(s); matched values were not displayed.')
if not count:
    raise SystemExit('No indexed files found. Stage the intended public tree first.')
print(f'Publication check passed: {count} indexed files; private paths and matched credentials are not displayed.')
