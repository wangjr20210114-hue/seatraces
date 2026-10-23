"""下载并校验推荐实验使用的 ONNX 模型。"""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent / 'validation' / 'travel-models'
SPECS = [
    ('bge-base', 'Xenova/bge-base-zh-v1.5', '71e50dc531959f9e04ebf190ea25b00261a0a186'),
    ('e5-small', 'Xenova/multilingual-e5-small', '761b726dd34fb83930e26aab4e9ac3899aa1fa78'),
]
FILES = ['config.json', 'tokenizer_config.json', 'tokenizer.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx']


def verify(raw, meta):
    if len(raw) != meta['size']:
        raise ValueError('File size mismatch: '+meta['rfilename'])
    if 'lfs' in meta:
        actual = hashlib.sha256(raw).hexdigest()
        expected = meta['lfs']['sha256']
    else:
        actual = hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
        expected = meta['blobId']
    if actual != expected:
        raise ValueError('Pinned Hub object digest mismatch: '+meta['rfilename'])


def main():
    if sys.argv[1:] != ['--local'] or os.getenv('NODE_ENV') == 'production':
        raise SystemExit('Only --local is allowed')
    ROOT.mkdir(parents=True, exist_ok=True)
    manifest = {'scope': 'offline', 'activationAllowed': False, 'models': []}
    for alias, repo, revision in SPECS:
        url = 'https://huggingface.co/api/models/'+repo+'/revision/'+revision+'?blobs=true'
        with urllib.request.urlopen(url, timeout=45) as response:
            metadata = json.load(response)
        if metadata['sha'] != revision:
            raise ValueError('Revision mismatch')
        files = {f['rfilename']: f for f in metadata['siblings']}
        model = {'alias': alias, 'repo': repo, 'revision': revision, 'files': []}
        for name in FILES:
            meta = files[name]
            if not 0 < meta['size'] < 150_000_000:
                raise ValueError('Unexpected file size')
            target = ROOT/'models'/alias/name
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                verify(target.read_bytes(), meta)
            else:
                url = 'https://huggingface.co/'+repo+'/resolve/'+revision+'/'+name
                part = target.with_suffix(target.suffix+'.part')
                for attempt in range(3):
                    try:
                        with urllib.request.urlopen(url, timeout=60) as response, part.open('wb') as out:
                            received = 0
                            while chunk := response.read(1024*1024):
                                received += len(chunk)
                                if received > meta['size']:
                                    raise ValueError('Download exceeds pinned size')
                                out.write(chunk)
                        verify(part.read_bytes(), meta)
                        part.replace(target)
                        break
                    except (OSError, TimeoutError):
                        if attempt == 2:
                            raise
                        time.sleep(2)
            model['files'].append({'name': name, 'bytes': meta['size'], 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
            print(json.dumps({'model': alias, 'verified': name, 'bytes': meta['size']}), flush=True)
        manifest['models'].append(model)
        (ROOT/'models-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()
