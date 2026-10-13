"""Create an isolated, loopback-only PostGIS service on the user's server."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import time

ROOT = Path('/home/ubuntu/seatraces-osm')
NAME = 'seatraces-osm-db'
IMAGE = 'postgis/postgis:16-3.5'


def docker(*args, **kwargs):
    return subprocess.run(['sudo', '-n', 'docker', *args], check=True, **kwargs)


def main():
    if shutil.disk_usage(ROOT).free < 12 * 1024**3:
        raise RuntimeError('Need at least 12 GiB free before deploying')
    ROOT.mkdir(exist_ok=True)
    os.umask(0o077)
    config_file = ROOT / 'database.json'
    existing = docker('ps', '-a', '--filter', 'name=^/' + NAME + '$', '--format', '{{.Names}}', capture_output=True, text=True).stdout.strip()
    if existing:
        if not config_file.exists():
            raise RuntimeError('Container exists without this deployment configuration; inspect manually')
        print('Database already deployed; existing container preserved')
        return
    if (ROOT / 'pgdata').exists() and any((ROOT / 'pgdata').iterdir()):
        raise RuntimeError('Refusing to initialize over existing database files')
    if config_file.exists():
        config = json.loads(config_file.read_text())
    else:
        config = {'host': '127.0.0.1', 'port': 55432, 'dbname': 'seatraces_osm', 'user': 'seatraces_osm', 'password': secrets.token_urlsafe(32)}
        config_file.write_text(json.dumps(config))
        config_file.chmod(0o600)
    env = ROOT / 'database.env'
    env.write_text('POSTGRES_DB=seatraces_osm\nPOSTGRES_USER=seatraces_osm\nPOSTGRES_PASSWORD=' + config['password'] + '\n')
    env.chmod(0o600)
    digest = json.loads(docker('image', 'inspect', IMAGE, capture_output=True, text=True).stdout)[0]['RepoDigests'][0]
    docker('run', '-d', '--name', NAME, '--restart', 'unless-stopped', '--cpus', '0.75', '--memory', '768m', '--memory-swap', '1024m', '--pids-limit', '128', '--shm-size', '128m',
           '--label', 'com.seatraces.purpose=osm', '--env-file', str(env), '-p', '127.0.0.1:55432:5432', '-v', str(ROOT / 'pgdata') + ':/var/lib/postgresql/data',
           '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
           '--health-cmd', 'pg_isready -U seatraces_osm -d seatraces_osm', '--health-interval', '30s', '--health-retries', '3',
           digest, 'postgres', '-c', 'shared_buffers=128MB', '-c', 'work_mem=4MB', '-c', 'maintenance_work_mem=64MB', '-c', 'max_connections=30', '-c', 'effective_cache_size=512MB')
    for _ in range(30):
        probe = subprocess.run(['sudo', '-n', 'docker', 'exec', NAME, 'pg_isready', '-U', 'seatraces_osm', '-d', 'seatraces_osm'], capture_output=True)
        if probe.returncode == 0:
            (ROOT / 'deployment.json').write_text(json.dumps({'container': NAME, 'image': digest, 'listen': '127.0.0.1:55432', 'memory_limit_mib': 768, 'cpu_limit': 0.75}, indent=2))
            print('PostGIS ready on loopback; credentials remain in database.json (0600)')
            return
        time.sleep(2)
    raise RuntimeError('Database did not become ready; inspect container logs')


if __name__ == '__main__':
    main()
