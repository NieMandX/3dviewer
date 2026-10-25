"""Read a short-lived GET URL on stdin; emit only integrity and timing results."""
import hashlib
import json
import sys
import time
import urllib.request

config = json.load(sys.stdin)
started = time.monotonic()
count = 0
digest = hashlib.sha256()
try:
    with urllib.request.urlopen(config['url'], timeout=45) as response:
        while block := response.read(1024 * 1024):
            count += len(block)
            if count > config['bytes']:
                raise ValueError('Object is larger than the saved source')
            if time.monotonic() - started > 600:
                raise TimeoutError('Download exceeded ten minutes')
            digest.update(block)
    verified = count == config['bytes'] and digest.hexdigest() == config['sha256']
    elapsed = time.monotonic() - started
    print(json.dumps({'verified': verified, 'bytes': count,
                      'seconds': round(elapsed, 3),
                      'megabitsPerSecond': round(count * 8 / elapsed / 1e6, 2)}))
    sys.exit(0 if verified else 1)
except Exception as error:
    # Exception strings can include the presigned URL. Do not print them.
    print(json.dumps({'verified': False, 'bytes': count,
                      'seconds': round(time.monotonic() - started, 3),
                      'errorType': type(error).__name__}))
    sys.exit(1)
