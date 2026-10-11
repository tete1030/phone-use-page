import contextlib
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock

sys.path.insert(0, '/opt/coturn-supervisor')
sys.path.insert(0, str(Path(__file__).parent))
from supervisor import Settings, Supervisor, atomic_write


class SupervisorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cert_temp = tempfile.TemporaryDirectory()
        cls.certs = Path(cls.cert_temp.name)
        def command(*args):
            subprocess.run(['openssl', *args], cwd=cls.certs, check=True, capture_output=True)
        command('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem',
                '-days', '7', '-subj', '/CN=Fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE')
        (cls.certs / 'extensions').write_text('subjectAltName=DNS:turn.example.test\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n')
        for name, serial in [('one', '101'), ('two', '202')]:
            command('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key', '-out', name + '.csr', '-subj', '/CN=turn.example.test')
            command('x509', '-req', '-in', name + '.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-set_serial', serial,
                    '-out', name + '.pem', '-days', '5', '-extfile', 'extensions')

    @classmethod
    def tearDownClass(cls):
        cls.cert_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.base = self.root / 'base.conf'
        self.base.write_text('realm=turn.example.test\nstatic-auth-secret=fixture-private-secret\nno-stdout-log\ncert=/old\npkey=/old\n')
        self.settings = Settings(self.base, self.root / 'state', self.source, 'turn.example.test', ca_file=str(self.certs / 'ca.pem'))
        self.install('one')
        self.output = io.StringIO()
        self.capture = contextlib.redirect_stdout(self.output)
        self.capture.__enter__()
        self.addCleanup(self.capture.__exit__, None, None, None)

    def install(self, name, key=None):
        atomic_write(self.source / 'fullchain.pem', (self.certs / (name + '.pem')).read_bytes() + (self.certs / 'ca.pem').read_bytes())
        atomic_write(self.source / 'privkey.pem', (self.certs / ((key or name) + '.key')).read_bytes())

    def test_invalid_rotation_retains_generation_and_valid_rotation_sends_only_usr2(self):
        supervisor = Supervisor(self.settings)
        self.assertTrue(supervisor.certificate_check())
        old = supervisor.cert_hash
        child = Mock()
        child.poll.return_value = None
        supervisor.child = child
        self.install('two', 'one')
        self.assertFalse(supervisor.certificate_check())
        self.assertEqual(supervisor.cert_hash, old)
        self.assertEqual((supervisor.certificates / 'current').resolve().name, old)
        child.send_signal.assert_not_called()
        self.install('two')
        self.assertTrue(supervisor.certificate_check())
        self.assertNotEqual(supervisor.cert_hash, old)
        child.send_signal.assert_called_once_with(signal.SIGUSR2)
        self.assertEqual(supervisor.status['childRestarts'], 0)

    def test_wrong_hostname_or_short_validity_cannot_publish_a_certificate(self):
        self.settings.hostname = 'wrong.example.test'
        supervisor = Supervisor(self.settings)
        self.assertFalse(supervisor.certificate_check())
        self.assertFalse((supervisor.certificates / 'current').exists())
        self.settings.hostname = 'turn.example.test'
        self.settings.min_validity = 7 * 86400
        supervisor = Supervisor(self.settings)
        self.assertFalse(supervisor.certificate_check())

    def test_symlink_rotation_is_followed_and_cached_valid_cert_survives_source_failure(self):
        for p in self.source.iterdir():
            p.unlink()
        for target, source in [('fullchain.pem', 'one.pem'), ('privkey.pem', 'one.key')]:
            (self.source / target).symlink_to(self.certs / source)
        supervisor = Supervisor(self.settings)
        self.assertTrue(supervisor.certificate_check())
        (self.source / 'fullchain.pem').unlink()
        recovered = Supervisor(self.settings)
        self.assertFalse(recovered.certificate_check())
        self.assertEqual(recovered.cert_hash, supervisor.cert_hash)

    def test_ambiguous_private_and_failed_dns_keep_the_last_public_address(self):
        self.settings.public_hostname = 'wan.example.test'
        self.settings.private_ip = '192.0.2.10'
        def result(*ips):
            return [(2, 1, 6, '', (ip, 443)) for ip in ips]
        supervisor = Supervisor(self.settings, resolver=lambda *_: result('1.1.1.1'))
        self.assertTrue(supervisor.ip_check())
        self.assertEqual(supervisor.public_ip, '1.1.1.1')
        for addresses in [result('1.1.1.1', '8.8.8.8'), result('192.168.1.1')]:
            supervisor.resolver = lambda *_: addresses
            self.assertFalse(supervisor.ip_check())
            self.assertEqual(supervisor.public_ip, '1.1.1.1')
        supervisor.resolver = Mock(side_effect=OSError('DNS down'))
        self.assertFalse(supervisor.ip_check())
        self.assertEqual(supervisor.public_ip, '1.1.1.1')

    def test_logging_deadline_expires_and_config_preserves_secret_and_security_options(self):
        now = 1000
        supervisor = Supervisor(self.settings, clock=lambda: now)
        atomic_write(supervisor.s.state / 'diagnostic.json', json.dumps({'enabled': True, 'expiresAt': 1060}))
        self.assertTrue(supervisor.diagnostic_check())
        self.assertIn('\nverbose\n', supervisor.render())
        self.assertNotIn('no-stdout-log', supervisor.render())
        now = 1060
        self.assertTrue(supervisor.diagnostic_check())
        self.assertIn('no-stdout-log', supervisor.render())
        self.assertNotIn('\nverbose\n', supervisor.render())
        self.assertIn('static-auth-secret=fixture-private-secret', supervisor.render())
        self.assertNotIn('fixture-private-secret', self.output.getvalue())

    def test_invalid_diagnostic_request_cannot_inject_config_or_extend_indefinitely(self):
        supervisor = Supervisor(self.settings, clock=lambda: 1000)
        for data in [{'enabled': True, 'expiresAt': 999999}, {'enabled': True, 'expiresAt': 1030, 'options': 'allow-loopback-peers'}]:
            atomic_write(supervisor.s.state / 'diagnostic.json', json.dumps(data))
            supervisor.diagnostic_check()
            self.assertFalse(supervisor.diagnostic)

    def test_state_is_private_and_restart_circuit_breaker_is_bounded(self):
        supervisor = Supervisor(self.settings)
        for now in [10, 20, 30, 40, 50]:
            supervisor.child_failed(now)
        self.assertTrue(supervisor.status['crashLoop'])
        self.assertLessEqual(supervisor.retry_at - 50, 60)
        supervisor.publish()
        path = supervisor.s.state / 'status.json'
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('fixture-private-secret', path.read_text())

    def test_environment_rejects_unbounded_intervals_and_missing_ip_mapping(self):
        for env in [{'TURN_CERT_HOSTNAME': 'turn.example.test', 'TURN_CERT_INTERVAL_SECONDS': '0'},
                    {'TURN_CERT_HOSTNAME': 'turn.example.test', 'TURN_PUBLIC_HOSTNAME': 'wan.example.test'}]:
            with self.assertRaises(ValueError):
                Settings.environment(env)

    def test_concurrent_requests_publish_complete_private_files_without_expiry_overwrite(self):
        path = self.root / 'request.json'
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda n: atomic_write(path, json.dumps({'enabled': True, 'expiresAt': n})), range(100)))
        self.assertIsInstance(json.loads(path.read_text())['expiresAt'], int)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.root.glob('request.json.*')), [])
        supervisor = Supervisor(self.settings, clock=lambda: 1000)
        request = json.dumps({'enabled': True, 'expiresAt': 900})
        atomic_write(supervisor.s.state / 'diagnostic.json', request)
        supervisor.diagnostic_check()
        self.assertFalse(supervisor.diagnostic)
        self.assertEqual((supervisor.s.state / 'diagnostic.json').read_text(), request)


if __name__ == '__main__':
    unittest.main()
