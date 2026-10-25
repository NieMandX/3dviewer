"""Generate local-only staging configuration without emitting credentials."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--revision', required=True)
args = parser.parse_args()
if not re.fullmatch(r'[a-f0-9]{7,40}(?:-staging)?', args.revision):
    raise SystemExit('Expected a Git revision, optionally followed by -staging')
if os.geteuid() != 0:
    raise SystemExit('Run as root on the staging VM')
os.umask(0o077)
root = Path('/etc/lpmview-voice')
root.mkdir(mode=0o700, exist_ok=True)
root.chmod(0o700)

def image_digest(tag):
    result = subprocess.check_output(
        ['docker', 'image', 'inspect', tag, '--format', '{{json .RepoDigests}}'],
        text=True)
    values = json.loads(result)
    if not values or not re.fullmatch(r'[^\s]+@sha256:[a-f0-9]{64}', values[0]):
        raise RuntimeError('Pull and inspect the official image first: ' + tag)
    return values[0]

images = {
    'LIVEKIT_IMAGE': image_digest('livekit/livekit-server:v1.13.11'),
    'CADDY_IMAGE': image_digest('caddy:2-alpine'),
    'NODE_IMAGE': image_digest('node:22-alpine'),
    'SOURCE_REVISION': args.revision,
}

secret_file = root / 'livekit-keys.json'
if secret_file.exists():
    keys = json.loads(secret_file.read_text())
else:
    keys = {'key': 'AGR' + secrets.token_hex(12), 'secret': secrets.token_hex(32)}
    with secret_file.open('x') as target:
        json.dump(keys, target)

# JSON is valid YAML and avoids quoting/generated YAML ambiguities.
livekit = {
    'port': 7880,
    'rtc': {'tcp_port': 7881, 'udp_port': 7882, 'use_external_ip': False},
    'keys': {keys['key']: keys['secret']},
    'turn': {'enabled': False},
    'room': {'empty_timeout': 60, 'departure_timeout': 20, 'max_participants': 20},
    'logging': {'level': 'warn'},
}
(root / 'livekit.json').write_text(json.dumps(livekit, indent=2) + '\n')
(root / 'voice-api.env').write_text(
    'LIVEKIT_API_KEY=' + keys['key'] + '\n'
    'LIVEKIT_API_SECRET=' + keys['secret'] + '\n'
    'LIVEKIT_WS_URL=ws://127.0.0.1:8090\n'
    'VOICE_TOKEN_TTL=10m\n'
    'SUPABASE_URL=http://127.0.0.1:9\n'
    'SUPABASE_SERVICE_ROLE_KEY=\n'
    'VOICE_API_ALLOWED_ORIGINS=http://127.0.0.1:8090\n')
compose_env = Path(__file__).resolve().parent / '.env'
compose_env.write_text(''.join(f'{key}={value}\n' for key, value in images.items()))
for path in [secret_file, root / 'livekit.json', root / 'voice-api.env', compose_env]:
    path.chmod(0o600)
print(json.dumps({'staging': True, 'backendConfigured': False, 'images': images}))
