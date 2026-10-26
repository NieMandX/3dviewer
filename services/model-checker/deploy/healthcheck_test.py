import importlib.util
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('healthcheck', Path(__file__).with_name('healthcheck.py'))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class HealthTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        for name in ('subprocess.run', 'shutil.disk_usage', 'urllib.request.build_opener'):
            # The module is loaded by path rather than installed as a package.
            target = health
            parts = name.split('.')
            for part in parts[:-1]:
                target = getattr(target, part)
            patcher = patch.object(target, parts[-1])
            setattr(self, parts[-1], patcher.start())
            self.addCleanup(patcher.stop)
        self.disk_usage.return_value.free = 8*1024**3
        self.response = MagicMock(status=200)
        self.response.read.return_value = b'{"ok":true}'
        self.build_opener.return_value.open.return_value.__enter__.return_value = self.response

    def test_defaults_preserve_old_listener(self):
        health.check_health()
        self.build_opener.return_value.open.assert_called_once_with('http://172.18.0.1:8081/health', timeout=10)
        self.assertEqual(self.run.call_count, 3)
        for call in self.run.call_args_list:
            self.assertTrue(call.kwargs['check'])
            self.assertEqual(call.kwargs['timeout'], 10)
        self.response.read.assert_called_once_with(1025)

    def test_cloudru_override_and_no_proxy_or_redirect(self):
        os.environ['MODEL_CHECK_HEALTH_URL'] = 'http://127.0.0.1:8081/health'
        health.check_health()
        self.build_opener.return_value.open.assert_called_once_with('http://127.0.0.1:8081/health', timeout=10)
        proxy, redirects = self.build_opener.call_args.args
        self.assertEqual(proxy.proxies, {})
        self.assertIsNone(redirects.redirect_request(None, None, 302, '', {}, 'http://example.org'))

    def test_rejects_remote_or_credentialed_urls(self):
        for url in ('https://example.org/health', 'http://localhost:8081/health',
                    'http://user:secret@127.0.0.1:8081/health', 'http://127.0.0.1:8081/health?key=x'):
            with self.subTest(url=url):
                os.environ['MODEL_CHECK_HEALTH_URL'] = url
                with self.assertRaises(ValueError):
                    health.check_health()
        self.run.assert_not_called()

    def test_stopped_service_fails_before_http(self):
        self.run.side_effect = subprocess.CalledProcessError(3, 'systemctl')
        with self.assertRaises(subprocess.CalledProcessError):
            health.check_health()
        self.build_opener.assert_not_called()

    def test_insufficient_disk_fails_before_http(self):
        self.disk_usage.return_value.free = 8*1024**3 - 1
        with self.assertRaises(RuntimeError):
            health.check_health()
        self.build_opener.assert_not_called()

    def test_unhealthy_or_unbounded_body_rejected(self):
        for status, body in ((503, b'{"ok":true}'), (200, b'x'*1025), (200, b'{}'),
                             (200, b'{"ok":false}'), (200, b'{"ok":1}'), (200, b'[]'), (200, b'bad json')):
            with self.subTest(status=status, body=body[:30]):
                self.response.status = status
                self.response.read.return_value = body
                with self.assertRaises((RuntimeError, ValueError)):
                    health.check_health()

    def test_connection_error_is_not_success(self):
        self.build_opener.return_value.open.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            health.check_health()


if __name__ == '__main__':
    unittest.main()
