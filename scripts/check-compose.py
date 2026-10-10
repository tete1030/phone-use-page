#!/usr/bin/env python3
"""Validate deployment recipes using synthetic settings; never start containers."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
base = {
    'CONSOLE_UID': str(os.getuid()), 'CONSOLE_GID': str(os.getgid()),
    'ANDROID_USB_GID': str(os.getgid()), 'ANDROID_SERIAL': '',
    'WEBRTC_ENABLED': '0', 'WEBRTC_STUN_URL': '', 'VIDEO_WSS_FALLBACK': '1',
    'COTURN_URL': 'turns:turn.example.com:5349?transport=tcp',
    'COTURN_IMAGE': 'coturn/coturn:4.6.3',
    'TURN_UID': str(os.getuid()), 'TURN_GID': str(os.getgid()),
    'TURN_CONFIG_PATH': '/tmp/fixture-turn.conf', 'TURN_CERTIFICATE_DIR': '/tmp/fixture-certs',
}
cases = [
    ('default-wss', [], {}, '0', 'none', '1', set()),
    ('wss-only-override', ['compose.wss.yaml'], {'WEBRTC_ENABLED': '1', 'WEBRTC_TURN_PROVIDER': 'cloudflare'}, '0', 'cloudflare', '1', set()),
    ('direct', [], {'WEBRTC_ENABLED': '1', 'VIDEO_WSS_FALLBACK': '0'}, '1', 'none', '0', set()),
    ('direct-and-wss', [], {'WEBRTC_ENABLED': '1'}, '1', 'none', '1', set()),
    ('coturn', ['compose.coturn.yaml'], {'VIDEO_WSS_FALLBACK': '0'}, '1', 'coturn', '0', {'coturn-key'}),
    ('cloudflare', ['compose.turn.yaml'], {'VIDEO_WSS_FALLBACK': '0'}, '1', 'cloudflare', '0', {'cloudflare-turn-key'}),
    ('coturn-and-wss', ['compose.coturn.yaml'], {}, '1', 'coturn', '1', {'coturn-key'}),
    ('cloudflare-and-wss', ['compose.turn.yaml'], {}, '1', 'cloudflare', '1', {'cloudflare-turn-key'}),
    ('both-relays', ['compose.coturn.yaml', 'compose.fallback.yaml'], {'VIDEO_WSS_FALLBACK': '0'}, '1', 'coturn', '0', {'coturn-key', 'cloudflare-turn-key'}),
    ('both-relays-and-wss', ['compose.coturn.yaml', 'compose.fallback.yaml'], {}, '1', 'coturn', '1', {'coturn-key', 'cloudflare-turn-key'}),
]
with tempfile.TemporaryDirectory(prefix='phone-compose-') as directory:
    config = Path(directory) / 'compose.env'
    for label, overlays, changes, enabled, provider, wss, keys in cases:
        config.write_text(''.join(f'{key}={value}\n' for key, value in {**base, **changes}.items()))
        command = ['docker', 'compose', '--env-file', str(config), '-f', str(root / 'compose.yaml')]
        for overlay in overlays:
            command.extend(['-f', str(root / overlay)])
        command.extend(['config', '--format', 'json'])
        result = subprocess.check_output(command, cwd=root, env={k: os.environ[k] for k in ('PATH', 'HOME') if k in os.environ})
        service = json.loads(result)['services']['console']
        env = service['environment']
        assert (env['WEBRTC_ENABLED'], env['WEBRTC_TURN_PROVIDER'], env['VIDEO_WSS_FALLBACK']) == (enabled, provider, wss), label
        assert env['WEBRTC_STUN_URL'] == '', 'Compose must preserve explicitly disabled STUN'
        actual = {Path(v['target']).name for v in service['volumes'] if v['target'].startswith('/run/secrets/')}
        assert actual == keys | {'console-password'}, label
        if len(keys) == 2:
            assert env['WEBRTC_TURN_FALLBACK'] == 'cloudflare', label
        print(f'PASS {label} (configuration only)')
    command = ['docker', 'compose', '--env-file', str(config), '-f', str(root / 'examples/coturn/compose.yaml'), 'config', '--quiet']
    subprocess.run(command, check=True, env={k: os.environ[k] for k in ('PATH', 'HOME') if k in os.environ})
    print('PASS standalone coturn recipe (configuration only)')
