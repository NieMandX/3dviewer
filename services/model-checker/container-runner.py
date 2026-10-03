"""Run one ZIP in a disposable, network-isolated Linux container.

Only a private copy of this file is mounted, never its containing user folder.
Production runner for the dedicated rootless Docker daemon on a shared host.
Container UID 0 maps to the unprivileged daemon user, not host root.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import tempfile
import time
import uuid

IMAGE = 'lpmview-checker-pilot:1.6.1-blender5.1.0'
MAX_BYTES = 2 * 1024**3

def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            result.update(block)
    return result.hexdigest()

def run(args):
    root = Path(__file__).resolve().parent
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,47}', args.name):
        raise ValueError('Use a short lowercase job label with digits/hyphens.')
    info = json.loads(subprocess.check_output(['docker', 'info', '--format', '{{json .}}'], text=True, timeout=15))
    if 'name=rootless' not in info.get('SecurityOptions', []) or info.get('CgroupVersion') != '2' or info.get('CgroupDriver') != 'systemd':
        raise RuntimeError('Rootless Docker with systemd cgroup v2 is required.')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', args.image):
        raise ValueError('An immutable Docker image ID is required.')
    source = args.source.resolve(strict=True)
    if not source.is_file() or source.suffix != '.zip' or not 0 < source.stat().st_size <= MAX_BYTES:
        raise ValueError('Expected a regular lowercase .zip file, up to 2 GiB.')
    if args.timeout <= 0:
        raise ValueError('Timeout must be positive.')
    output = (args.output or root/'results'/args.name).resolve()
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    metadata = {'platform':'linux/amd64', 'host_machine':platform.machine(),
                'host_system':platform.system(), 'source_name':source.name,
                'source_sha256':digest(source), 'status':'preparing'}
    if args.expected_sha256 and metadata['source_sha256'] != args.expected_sha256:
        raise ValueError('Source version changed since the job was created.')
    container = None
    attached = None
    isolated_directory = tempfile.TemporaryDirectory(prefix='lpmview-checker-input-')
    started = time.monotonic()
    try:
        isolated_input = Path(isolated_directory.name)
        copy = isolated_input/source.name
        with source.open('rb') as src, copy.open('wb') as dst:
            copied = 0
            for chunk in iter(lambda: src.read(1024*1024), b''):
                copied += len(chunk)
                if copied > MAX_BYTES:
                    raise ValueError('Source grew beyond size limit.')
                dst.write(chunk)
        if digest(copy) != metadata['source_sha256']:
            raise ValueError('Source changed while copying.')
        copy.chmod(0o444)
        container = 'lpmview-checker-'+args.name+'-'+uuid.uuid4().hex[:8]
        command = ['docker','create','--platform','linux/amd64','--name',container,
            '--init','--network','none','--read-only','--cap-drop','ALL',
            '--security-opt','no-new-privileges:true','--pids-limit','128',
            '--memory','4g','--memory-swap','4g','--cpus','2','--user','0:0',
            '--label','lpmview.model-checker=true',
            '--log-driver','local','--log-opt','max-size=10m','--log-opt','max-file=2',
            '--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=2g,mode=1777',
            '--ulimit','nofile=2048:2048',
            '--mount',f'type=bind,src={isolated_input},dst=/input,readonly',
            '--mount',f'type=bind,src={output},dst=/output', args.image,
            '--source','/input/'+source.name,'--output','/output/job',
            '--uv-index-cache','--timeout',str(args.timeout)]
        if args.geojson_supplement: command.append('--geojson-supplement')
        if args.html_report: command.append('--html-report')
        subprocess.check_output(command,text=True,timeout=60)
        inspect = json.loads(subprocess.check_output(['docker','inspect',container],text=True,timeout=30))[0]
        host = inspect['HostConfig']
        metadata.update(image_id=inspect['Image'], runtime={key:host[key] for key in
            ['NetworkMode','ReadonlyRootfs','CapDrop','SecurityOpt','PidsLimit','Memory','MemorySwap','NanoCpus','Tmpfs','Init']},
            user=inspect['Config']['User'], mounts=[{key:mount[key] for key in ['Destination','RW']} for mount in inspect['Mounts']])
        with (output/'container.log').open('w') as log:
            attached=subprocess.Popen(['docker','start','--attach',container],stdout=log,stderr=subprocess.STDOUT)
            while attached.poll() is None:
                if time.monotonic()-started > args.timeout+40:
                    raise TimeoutError('Container exceeded wrapper deadline.')
                if args.owner_lease:
                    try: lease_age=time.time()-args.owner_lease.stat().st_mtime
                    except OSError: lease_age=float('inf')
                    if not -5 <= lease_age <= 10:
                        raise TimeoutError('Dispatcher lease expired; stop its container.')
                time.sleep(0.1)
        result = json.loads(subprocess.check_output(['docker','inspect',container],text=True,timeout=30))[0]
        metadata.update(exit_code=result['State']['ExitCode'],oom_killed=result['State']['OOMKilled'],
                        input_unchanged=digest(source)==metadata['source_sha256'] and digest(copy)==metadata['source_sha256'],
                        status='completed' if result['State']['ExitCode']==0 else 'incomplete')
        if metadata['exit_code'] != 0 or not metadata['input_unchanged']:
            raise RuntimeError('Linux checker failed; inspect output/container.log and job/.')
    except BaseException as error:
        metadata.update(status='incomplete',error=str(error))
        raise
    finally:
        if container:
            subprocess.run(['docker','rm','--force',container],check=False,stdout=subprocess.DEVNULL,timeout=30)
        if attached and attached.poll() is None:
            attached.terminate()
            try: attached.wait(timeout=5)
            except subprocess.TimeoutExpired: attached.kill(); attached.wait(timeout=5)
        isolated_directory.cleanup()
        metadata['wall_seconds'] = round(time.monotonic()-started,3)
        (output/'container.json').write_text(json.dumps(metadata,indent=2)+'\n')
        print(json.dumps(metadata,indent=2),flush=True)

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name')
    parser.add_argument('source',type=Path)
    parser.add_argument('--output',type=Path)
    parser.add_argument('--image',required=True)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--owner-lease',type=Path,help='Optional dispatcher heartbeat file; stop container when it is older than 10 seconds.')
    parser.add_argument('--timeout',type=float,default=600)
    parser.add_argument('--geojson-supplement',action='store_true')
    parser.add_argument('--html-report',action='store_true')
    def cancelled(signum, frame):
        raise KeyboardInterrupt('Container job cancelled.')
    signal.signal(signal.SIGTERM, cancelled)
    run(parser.parse_args())
