#!/usr/bin/env python3
"""Validate deployment recipes using synthetic settings; never start containers."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]


def example_env(name):
    values = {}
    for line in (root / 'examples/deployment' / name).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        assert separator and key not in values, f'Invalid or duplicate example setting: {name}'
        values[key] = value
    return values


base = {
    'CONSOLE_UID': str(os.getuid()), 'CONSOLE_GID': str(os.getgid()),
    'ANDROID_USB_GID': str(os.getgid()), 'ANDROID_SERIAL': '',
    'WEBRTC_ENABLED': '0', 'WEBRTC_STUN_URL': '', 'VIDEO_WSS_FALLBACK': '1',
    'COTURN_URL': 'turns:turn.example.com:5349?transport=tcp',
    'COTURN_IMAGE': 'coturn/coturn:4.6.3',
    'TURN_UID': str(os.getuid()), 'TURN_GID': str(os.getgid()),
    'TURN_CONFIG_PATH': '/tmp/fixture-turn.conf', 'TURN_CERTIFICATE_DIR': '/tmp/fixture-certs',
}
native = example_env('local.env.example')
assert (native['HOST'], native['WEBRTC_ENABLED'], native['VIDEO_WSS_FALLBACK']) == ('127.0.0.1', '0', '1')
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
web_examples = ['home-proxy.compose.env.example', 'tunnel-wss.compose.env.example']
video_examples = [
    (None, ['compose.wss.yaml'], '0', 'none', set()),
    ('video-coturn.compose.env.example', ['compose.coturn.yaml'], '1', 'coturn', {'coturn-key'}),
    ('video-cloudflare.compose.env.example', ['compose.turn.yaml'], '1', 'cloudflare', {'cloudflare-turn-key'}),
    ('video-combined.compose.env.example', ['compose.coturn.yaml', 'compose.fallback.yaml'], '1', 'coturn', {'coturn-key', 'cloudflare-turn-key'}),
    ('video-direct.compose.env.example', [], '1', 'none', set()),
]
for web_name in web_examples:
    for video_name, overlays, enabled, provider, keys in video_examples:
        changes = {**example_env(web_name), **(example_env(video_name) if video_name else {})}
        cases.append((web_name + '+' + (video_name or 'wss'), overlays, changes, enabled, provider, '1', keys))
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
        assert env['WEBRTC_STUN_URL'] == changes.get('WEBRTC_STUN_URL', ''), 'Compose must preserve configured STUN'
        actual = {Path(v['target']).name for v in service['volumes'] if v['target'].startswith('/run/secrets/')}
        assert actual == keys | {'console-password'}, label
        if len(keys) == 2:
            assert env['WEBRTC_TURN_FALLBACK'] == 'cloudflare', label
        for source, target in [('CONSOLE_HTTP_HOST', 'HOST'), ('CONSOLE_PUBLIC_ORIGIN', 'CONSOLE_PUBLIC_ORIGIN'), ('CONSOLE_BASE_PATH', 'CONSOLE_BASE_PATH'), ('CONSOLE_COOKIE_PATH', 'CONSOLE_COOKIE_PATH'), ('TRUST_PROXY', 'TRUST_PROXY')]:
            if source in changes:
                assert env[target] == changes[source], label
        print(f'PASS {label} (configuration only)')
    command = ['docker', 'compose', '--env-file', str(config), '-f', str(root / 'examples/coturn/compose.yaml'), 'config', '--quiet']
    subprocess.run(command, check=True, env={k: os.environ[k] for k in ('PATH', 'HOME') if k in os.environ})
    print('PASS standalone coturn recipe (configuration only)')
