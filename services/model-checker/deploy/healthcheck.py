"""Local status probe; systemd records failures without printing credentials."""
import json
import os
import shutil
import subprocess
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def health_url():
    # Retain the existing Yandex default; Cloud.ru overrides only its own unit.
    url = os.environ.get('MODEL_CHECK_HEALTH_URL', 'http://172.18.0.1:8081/health')
    if url not in ('http://172.18.0.1:8081/health', 'http://127.0.0.1:8081/health'):
        raise ValueError('Checker health URL must be an approved local listener')
    return url


def check_health():
    url = health_url()
    for unit in ('lpmview-checker-worker.service', 'lpmview-checker-api.service', 'user@1001.service'):
        subprocess.run(['systemctl', 'is-active', '--quiet', unit], check=True, timeout=10)
    if shutil.disk_usage('/var/lib/lpmview-checker/work').free < 8*1024**3:
        raise RuntimeError('Checker workspace has less than 8 GiB free')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(url, timeout=10) as response:
        body = response.read(1025)
        if response.status != 200 or len(body) > 1024:
            raise RuntimeError('Checker API is not healthy')
        data = json.loads(body)
        if not isinstance(data, dict) or data.get('ok') is not True:
            raise RuntimeError('Checker API returned an invalid health result')


if __name__ == '__main__':
    check_health()
    print('checker_health_ok')
