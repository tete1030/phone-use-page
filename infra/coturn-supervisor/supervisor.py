#!/usr/bin/env python3
"""Supervise coturn and maintain TLS material, advertised IP and temporary logging."""
import argparse
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone


def atomic_write(path, data):
    path = Path(path)
    descriptor, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data if isinstance(data, bytes) else data.encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def interval(env, key, default):
    value = int(env.get(key, default))
    if not 1 <= value <= 86400:
        raise ValueError('Invalid maintenance interval: ' + key)
    return value


@dataclass
class Settings:
    base: Path
    state: Path
    source: Path
    hostname: str
    public_hostname: str = ''
    private_ip: str = ''
    ca_file: str = ''
    cert_interval: int = 60
    ip_interval: int = 300
    min_validity: int = 86400
    binary: str = '/usr/bin/turnserver'

    @classmethod
    def environment(cls, env=os.environ):
        hostname = env.get('TURN_CERT_HOSTNAME', '')
        if not re.fullmatch(r'[A-Za-z0-9.-]+', hostname):
            raise ValueError('TURN_CERT_HOSTNAME is required')
        public = env.get('TURN_PUBLIC_HOSTNAME', '')
        private = env.get('TURN_PRIVATE_IP', '')
        if public and (not re.fullmatch(r'[A-Za-z0-9.-]+', public) or not private):
            raise ValueError('IP maintenance needs a hostname and private IP')
        if private:
            ipaddress.IPv4Address(private)
        return cls(Path(env.get('TURN_BASE_CONFIG', '/etc/coturn/base.conf')),
                   Path(env.get('TURN_STATE_DIR', '/var/lib/coturn-supervisor')),
                   Path(env.get('TURN_CERT_SOURCE', '/cert-source/live/site')),
                   hostname, public, private, env.get('TURN_CA_FILE', ''),
                   interval(env, 'TURN_CERT_INTERVAL_SECONDS', 60),
                   interval(env, 'TURN_IP_INTERVAL_SECONDS', 300),
                   interval(env, 'TURN_MIN_CERT_VALIDITY_SECONDS', 86400),
                   env.get('TURN_BINARY', '/usr/bin/turnserver'))


class Supervisor:
    def __init__(self, settings, clock=time.time, monotonic=time.monotonic, resolver=socket.getaddrinfo):
        self.s = settings
        self.clock, self.monotonic, self.resolver = clock, monotonic, resolver
        self.s.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.certificates = self.s.state / 'certificates'
        self.certificates.mkdir(exist_ok=True, mode=0o700)
        self.base = self.s.base.read_text()
        self.child = None
        self.stop_requested = False
        self.cert_hash = None
        self.certificate_expires = None
        self.public_ip = None
        self.diagnostic = False
        self.retry_at = 0
        self.crashes = []
        self.lookup_thread = None
        self.lookup_result = None
        self.status = {'ready': False, 'certificateReloads': 0, 'childRestarts': 0,
                       'certificateError': None, 'publicIpError': None, 'diagnosticError': None,
                       'crashLoop': False}
        cached = self.s.state / 'status.json'
        if cached.exists():
            try:
                value = json.loads(cached.read_text()).get('publicIp')
                if value and ipaddress.IPv4Address(value).is_global:
                    self.public_ip = value
            except (ValueError, OSError):
                pass
        if not self.public_ip:
            match = re.search(r'^external-ip=([^/\s]+)', self.base, re.M)
            if match and ipaddress.IPv4Address(match[1]).is_global:
                self.public_ip = match[1]

    def log(self, event, **fields):
        print(json.dumps({'event': event, **fields}), flush=True)

    def command(self, args):
        result = subprocess.run(args, capture_output=True, timeout=10)
        if result.returncode:
            raise ValueError('TLS material validation failed')
        return result.stdout

    def validate(self, directory, minimum):
        certificate, key = directory / 'fullchain.pem', directory / 'privkey.pem'
        cert = certificate.read_bytes()
        blocks = re.findall(rb'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', cert, re.S)
        if not blocks:
            raise ValueError('Certificate chain is empty')
        atomic_write(directory / 'leaf.pem', blocks[0] + b'\n')
        atomic_write(directory / 'chain.pem', b'\n'.join(blocks[1:]) + b'\n')
        self.command(['openssl', 'x509', '-in', str(certificate), '-noout', '-checkend', str(minimum)])
        args = ['openssl', 'verify', '-purpose', 'sslserver', '-verify_hostname', self.s.hostname]
        if self.s.ca_file:
            args += ['-CAfile', self.s.ca_file]
        if len(blocks) > 1:
            args += ['-untrusted', str(directory / 'chain.pem')]
        self.command(args + [str(directory / 'leaf.pem')])
        public = self.command(['openssl', 'x509', '-in', str(certificate), '-pubkey', '-noout'])
        if public != self.command(['openssl', 'pkey', '-in', str(key), '-pubout']):
            raise ValueError('Certificate/key mismatch')
        expiry = self.command(['openssl', 'x509', '-in', str(certificate), '-noout', '-enddate']).decode().split('=', 1)[1].strip()
        return datetime.strptime(expiry, '%b %d %H:%M:%S %Y %Z').replace(tzinfo=timezone.utc).timestamp()

    def certificate_check(self):
        try:
            cert = (self.s.source / 'fullchain.pem').read_bytes()
            key = (self.s.source / 'privkey.pem').read_bytes()
            digest = hashlib.sha256(cert + b'\0' + key).hexdigest()
            if digest == self.cert_hash:
                self.command(['openssl', 'x509', '-in', str(self.certificates / 'current/fullchain.pem'),
                              '-noout', '-checkend', str(self.s.min_validity)])
                self.status['certificateError'] = None
                return False
            with tempfile.TemporaryDirectory(dir=self.certificates) as temporary:
                staging = Path(temporary)
                atomic_write(staging / 'fullchain.pem', cert)
                atomic_write(staging / 'privkey.pem', key)
                expires = self.validate(staging, self.s.min_validity)
                generation = self.certificates / digest
                if not generation.exists():
                    staging.rename(generation)
                link = self.certificates / 'current.new'
                link.unlink(missing_ok=True)
                link.symlink_to(digest, target_is_directory=True)
                os.replace(link, self.certificates / 'current')
            self.cert_hash = digest
            self.certificate_expires = expires
            self.status['certificateError'] = None
            if self.child and self.child.poll() is None:
                self.child.send_signal(signal.SIGUSR2)
                self.status['certificateReloads'] += 1
            self.log('certificate_ready', reloaded=bool(self.child))
            return True
        except (OSError, ValueError, subprocess.TimeoutExpired):
            if self.status['certificateError'] is None:
                self.log('certificate_check_failed', previous_material_retained=True)
            self.status['certificateError'] = 'Source TLS material unavailable or invalid'
            if not self.cert_hash and (self.certificates / 'current').is_symlink():
                current = self.certificates / 'current'
                try:
                    self.certificate_expires = self.validate(current, 0)
                    self.cert_hash = current.resolve().name
                except (OSError, ValueError, subprocess.TimeoutExpired):
                    pass
            return False

    def ip_check(self):
        if not self.s.public_hostname:
            return False
        try:
            if self.lookup_thread and self.lookup_thread.is_alive():
                raise OSError('Previous DNS lookup still running')
            self.lookup_result = {}
            result = self.lookup_result
            def lookup():
                try:
                    result['addresses'] = self.resolver(self.s.public_hostname, 443, socket.AF_INET, socket.SOCK_STREAM)
                except Exception:
                    result['error'] = True
            self.lookup_thread = threading.Thread(target=lookup, daemon=True)
            self.lookup_thread.start()
            self.lookup_thread.join(5)
            if self.lookup_thread.is_alive() or result.get('error'):
                raise OSError('DNS lookup failed or timed out')
            addresses = {item[4][0] for item in result['addresses']}
            if len(addresses) != 1 or not ipaddress.IPv4Address(next(iter(addresses))).is_global:
                raise ValueError('Expected one public IPv4')
            address = addresses.pop()
            changed = address != self.public_ip
            self.public_ip = address
            self.status['publicIpError'] = None
            if changed:
                self.log('public_ip_changed')
            return changed
        except (OSError, ValueError):
            if self.status['publicIpError'] is None:
                self.log('public_ip_check_failed', previous_address_retained=True)
            self.status['publicIpError'] = 'Public hostname lookup unavailable or ambiguous'
            return False

    def diagnostic_check(self):
        path = self.s.state / 'diagnostic.json'
        try:
            value = json.loads(path.read_text()) if path.exists() else {'enabled': False}
            if not isinstance(value, dict) or set(value) - {'enabled', 'expiresAt'} or not isinstance(value.get('enabled'), bool):
                raise ValueError('Invalid diagnostic request')
            expiry = value.get('expiresAt', 0)
            if value['enabled'] and (type(expiry) is not int or expiry > self.clock() + 3600):
                raise ValueError('Diagnostic deadline must be bounded')
            enabled = value['enabled'] and self.clock() < expiry
            changed = enabled != self.diagnostic
            self.diagnostic = enabled
            self.status['diagnosticError'] = None
            # Leave expired requests intact so expiry cannot overwrite a concurrent CLI request.
            return changed
        except (OSError, ValueError):
            self.status['diagnosticError'] = 'Invalid diagnostic request'
            changed = self.diagnostic
            self.diagnostic = False
            return changed

    def render(self):
        override = {'cert', 'pkey', 'pidfile'}
        if self.s.public_hostname:
            override.add('external-ip')
        if self.diagnostic:
            override |= {'verbose', 'extra-verbose', 'no-stdout-log'}
        lines = [line for line in self.base.splitlines() if line.strip().split('=', 1)[0] not in override]
        current = self.certificates / 'current'
        lines += ['cert=' + str(current / 'fullchain.pem'), 'pkey=' + str(current / 'privkey.pem'),
                  'pidfile=' + str(self.s.state / 'turnserver.pid')]
        if self.s.public_hostname and self.public_ip:
            lines.append('external-ip=' + self.public_ip + '/' + self.s.private_ip)
        if self.diagnostic:
            lines.append('verbose')
        return '\n'.join(lines) + '\n'

    def terminate_child(self):
        if self.child and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=5)
        self.child = None

    def start_child(self, reason):
        if not self.cert_hash or self.s.public_hostname and not self.public_ip:
            return
        running = self.child is not None
        self.terminate_child()
        atomic_write(self.s.state / 'turnserver.conf', self.render())
        self.child = subprocess.Popen([self.s.binary, '-c', str(self.s.state / 'turnserver.conf')])
        if running:
            self.status['childRestarts'] += 1
        self.log('turnserver_started', reason=reason)

    def child_failed(self, now):
        self.crashes = [x for x in self.crashes if now - x < 300] + [now]
        self.retry_at = now + min(60, 2 ** len(self.crashes))
        self.child = None
        self.status['crashLoop'] = len(self.crashes) >= 5
        self.log('turnserver_exited', retry_blocked=self.status['crashLoop'])

    def publish(self):
        alive = bool(self.child and self.child.poll() is None)
        valid = bool(self.certificate_expires and self.certificate_expires > self.clock())
        value = {**self.status, 'ready': alive and valid, 'updatedAt': self.clock(), 'pid': self.child.pid if alive else None,
                 'publicIp': self.public_ip, 'certificateHash': self.cert_hash,
                 'certificateExpiresAt': self.certificate_expires, 'diagnosticEnabled': self.diagnostic}
        atomic_write(self.s.state / 'status.json', json.dumps(value))

    def run(self):
        def stop(*_):
            self.stop_requested = True
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        next_cert = next_ip = next_status = 0
        try:
            while not self.stop_requested:
                now = self.monotonic()
                cert_changed = False
                if now >= next_cert:
                    cert_changed = self.certificate_check()
                    next_cert = now + self.s.cert_interval
                ip_changed = False
                if now >= next_ip:
                    ip_changed = self.ip_check()
                    next_ip = now + self.s.ip_interval
                logging_changed = self.diagnostic_check()
                if self.child and self.child.poll() is not None:
                    self.child_failed(now)
                try:
                    if self.child and (ip_changed or logging_changed):
                        self.start_child('public_ip_change' if ip_changed else 'diagnostic_change')
                    elif not self.child and now >= self.retry_at and not self.status['crashLoop']:
                        self.start_child('startup_or_retry')
                except OSError:
                    self.child_failed(now)
                if now >= next_status or cert_changed or ip_changed or logging_changed:
                    self.publish()
                    next_status = now + 10
                time.sleep(1)
        finally:
            self.terminate_child()
            self.publish()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', nargs='?', default='run', choices=['run', 'status', 'diagnostics-on', 'diagnostics-off'])
    parser.add_argument('--minutes', type=int, default=20)
    args = parser.parse_args()
    state = Path(os.environ.get('TURN_STATE_DIR', '/var/lib/coturn-supervisor'))
    if args.action == 'status':
        value = json.loads((state / 'status.json').read_text())
        print(json.dumps(value))
        if not value['ready'] or time.time() - value['updatedAt'] > 30:
            raise SystemExit(1)
    elif args.action.startswith('diagnostics-'):
        if not 1 <= args.minutes <= 60:
            parser.error('minutes must be 1–60')
        value = {'enabled': args.action == 'diagnostics-on'}
        if value['enabled']:
            value['expiresAt'] = int(time.time()) + args.minutes * 60
        atomic_write(state / 'diagnostic.json', json.dumps(value))
        print('Diagnostic request saved')
    else:
        settings = Settings.environment()
        settings.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (settings.state / 'supervisor.lock').open('a') as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            Supervisor(settings).run()


if __name__ == '__main__':
    main()
