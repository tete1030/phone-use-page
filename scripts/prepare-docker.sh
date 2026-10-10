#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
umask 077
python3 - <<'PY'
from pathlib import Path
import os,shutil,stat
uid=int(os.environ.get('CONSOLE_UID',1000))
if os.getuid()!=uid:
    raise SystemExit('CONSOLE_UID must match your user; export it before preparing and set it in compose.env')
for name in ['.local','.local/docker/state','.local/docker/home/.android']:
    p=Path(name);p.mkdir(parents=True,exist_ok=True,mode=0o700)
    if p.stat().st_uid!=uid:raise SystemExit('Deployment directory has an unexpected owner: '+name)
    p.chmod(0o700)
source=Path(os.environ.get('ADB_KEY_SOURCE_DIR',str(Path.home()/'.android')))
target=Path('.local/docker/home/.android')
for name in ['adbkey','adbkey.pub']:
    dest=target/name
    if not dest.exists() and (source/name).is_file():
        shutil.copyfile(source/name,dest);dest.chmod(0o600)
password=Path('.local/console-password')
if not password.is_file():raise SystemExit('Create .local/console-password before starting; no default password is generated')
if password.stat().st_uid!=uid or stat.S_IMODE(password.stat().st_mode)!=0o600:
    raise SystemExit('Password file must be owned by your user and have mode 0600')
if not 12<=len(password.read_text().rstrip('\r\n'))<=512:raise SystemExit('Password must be 12-512 characters')
config=Path('.local/compose.env')
if not config.exists():
    shutil.copyfile('compose.env.example',config);config.chmod(0o600)
print('Private deployment directories and compose.env prepared; secrets were not displayed')
PY
