"""Sequential, resumable country preparation with verified artifacts and bounded disk use."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
import ssl
from http.client import IncompleteRead
from urllib.error import URLError
from download import REGIONS, digest, download, emit


def prepare(region, root, reserve_gib):
    raw = root / 'raw'
    for attempt in range(8):
        try:
            source = download(region, raw, reserve_gib=reserve_gib)
            break
        except (URLError, TimeoutError, ConnectionError, ssl.SSLError, IncompleteRead) as error:
            emit('retry_download', region=region, attempt=attempt+1, message=str(error))
            if attempt == 7:
                raise
            time.sleep(min(30, 3 * (attempt+1)))
    output = root / 'processed' / (region + '.jsonl.gz')
    manifest_path = output.with_suffix('.gz.json')
    cache_root = (root / 'cache').resolve()
    cache = cache_root / (region + '-' + source['md5'] + '.locations')
    if output.exists() and manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding='utf8'))
        if manifest['pbf_sha256'] != source['sha256']:
            raise RuntimeError('Existing processed snapshot is from another PBF; preserve it before updating')
        if digest(output, 'sha256') != manifest['output_sha256']:
            raise RuntimeError('Existing processed snapshot failed checksum')
        if cache.exists():
            if cache.resolve().parent != cache_root or not cache.is_file():
                raise RuntimeError('Unexpected cache path; cleanup refused')
            cache.unlink()
        emit('prepared_already', region=region, rows=manifest['total'])
        return manifest
    # pyosmium can retain a mapped location file until process exit on Windows.
    # A dedicated worker closes it before the coordinator removes its own cache.
    subprocess.run([sys.executable, str(Path(__file__).with_name('extract.py')),
                    str(raw / source['path']), str(output), '--cache', str(cache),
                    '--reserve-gib', str(reserve_gib)], check=True)
    manifest = json.loads(manifest_path.read_text(encoding='utf8'))
    # Only remove this run's disposable location cache, after successful extraction.
    if cache.resolve().parent != cache_root or not cache.is_file():
        raise RuntimeError('Unexpected cache path; automatic cleanup refused')
    cache.unlink()
    emit('prepared', region=region, rows=manifest['total'], cache_removed=True)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('regions', nargs='+', choices=REGIONS)
    parser.add_argument('--directory', type=Path, default=Path('data/osm'))
    parser.add_argument('--reserve-gib', type=float, default=8)
    args = parser.parse_args()
    if args.reserve_gib < 4:
        parser.error('Keep at least 4 GiB free during country preparation')
    results = {}
    for region in args.regions:
        results[region] = prepare(region, args.directory.resolve(), args.reserve_gib)['total']
    emit('batch_prepared', regions=results)
