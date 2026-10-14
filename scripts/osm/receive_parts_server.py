"""Receive hash-checked PBF ranges; assemble only after all ranges verify."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path('/home/ubuntu/seatraces-osm/raw')


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while data := source.read(1024 * 1024):
            digest.update(data)
    return digest.hexdigest()


def load_manifest(path):
    manifest = json.loads(path.read_text())
    name = manifest['path']
    if Path(name).name != name or not name.endswith('.osm.pbf'):
        raise ValueError('Invalid artifact name')
    if len(manifest['sha256']) != 64 or any(c not in '0123456789abcdef' for c in manifest['sha256']):
        raise ValueError('Invalid source SHA-256')
    offset = 0
    for part in manifest['parts']:
        if part['offset'] != offset or part['bytes'] <= 0 or len(part['sha256']) != 64 or any(c not in '0123456789abcdef' for c in part['sha256']):
            raise ValueError('Invalid part boundaries')
        offset += part['bytes']
    if offset != manifest['bytes']:
        raise ValueError('Part total differs from source size')
    return manifest


def valid_part(path, spec):
    return path.is_file() and path.stat().st_size == spec['bytes'] and sha256(path) == spec['sha256']


def run(root, manifest, mode, index=None, stream=None, offset=0):
    os.umask(0o077)
    folder = root / ('.parts-' + manifest['sha256'])
    folder.mkdir(exist_ok=True)
    parts = manifest['parts']
    if mode == 'status':
        selected=range(len(parts)) if index is None else [index]
        if any(n < 0 or n >= len(parts) for n in selected):
            raise ValueError('Invalid part index')
        return {'complete': [n for n in selected if valid_part(folder / str(n), parts[n])],
                'partial_bytes': {str(n):(folder/(str(n)+'.partial')).stat().st_size for n in selected if (folder/(str(n)+'.partial')).is_file()}}
    if mode == 'receive':
        if index is None or not 0 <= index < len(parts):
            raise ValueError('Invalid part index')
        spec = parts[index]
        target = folder / str(index)
        temporary = folder / (str(index) + '.partial')
        if offset < 0 or offset > spec['bytes']:
            raise ValueError('Invalid resume offset')
        if offset and (not temporary.is_file() or temporary.stat().st_size != offset):
            raise ValueError('Partial file size changed')
        remaining, digest = spec['bytes']-offset, hashlib.sha256()
        if offset:
            with temporary.open('rb') as previous:
                while data := previous.read(1024*1024):
                    digest.update(data)
        with temporary.open('ab' if offset else 'wb') as output:
            while remaining:
                data = stream.read(min(1024 * 1024, remaining))
                if not data:
                    raise ValueError('Truncated input')
                output.write(data)
                digest.update(data)
                remaining -= len(data)
            if stream.read(1):
                raise ValueError('Unexpected extra input')
            output.flush()
            os.fsync(output.fileno())
        if digest.hexdigest() != spec['sha256']:
            temporary.unlink()
            raise ValueError('Part checksum mismatch')
        temporary.replace(target)
        return {'part': index, 'bytes': spec['bytes'], 'verified': True}
    if mode != 'assemble':
        raise ValueError('Unknown operation')
    target = root / manifest['path']
    if valid_part(target, manifest):
        return {'verified': True, 'bytes': manifest['bytes'], 'sha256': manifest['sha256'], 'already_complete': True}
    if shutil.disk_usage(root).free < manifest['bytes'] + 12 * 1024**3:
        raise RuntimeError('Assembly requires a 12 GiB free-space reserve')
    assembled = folder / 'assembled.partial'
    digest = hashlib.sha256()
    with assembled.open('wb') as output:
        for n, spec in enumerate(parts):
            part = folder / str(n)
            if not valid_part(part, spec):
                raise ValueError('Unverified part: ' + str(n))
            with part.open('rb') as source:
                while data := source.read(1024 * 1024):
                    output.write(data)
                    digest.update(data)
        output.flush()
        os.fsync(output.fileno())
    if assembled.stat().st_size != manifest['bytes'] or digest.hexdigest() != manifest['sha256']:
        raise ValueError('Assembled PBF checksum mismatch')
    assembled.replace(target)
    # Remove only this manifest's verified, reconstructable chunk files.
    for n, spec in enumerate(parts):
        (folder / str(n)).unlink()
    folder.rmdir()
    return {'verified': True, 'bytes': manifest['bytes'], 'sha256': manifest['sha256']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['status', 'receive', 'assemble'])
    parser.add_argument('manifest')
    parser.add_argument('--part', type=int)
    parser.add_argument('--offset', type=int, default=0)
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    if manifest_path.parent != ROOT or not manifest_path.name.endswith('-parts.json'):
        raise ValueError('Expected an OSM raw-directory part manifest')
    print(json.dumps(run(ROOT, load_manifest(manifest_path), args.mode, args.part, sys.stdin.buffer, args.offset)))
