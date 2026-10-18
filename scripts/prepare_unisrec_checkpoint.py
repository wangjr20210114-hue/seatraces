"""Fetch only the approved public checkpoint; never execute archived code."""
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

SIZE = 34981699
SHA256 = '42da736452bed105bb04d2ac4f9d74c54b89d1a9c5115269f16d0d5a8cd92d9c'
SOURCE = 'https://drive.usercontent.google.com/download?id=14BxnS-P2gXrT1OHJqWOoFoXCAgFvoXpF&export=download&confirm=t'


def verify(path):
    if path.stat().st_size != SIZE or hashlib.sha256(path.read_bytes()).hexdigest() != SHA256:
        raise ValueError('Checkpoint size/digest mismatch; file is not accepted')


def main():
    if sys.argv[1:] != ['--local'] or os.getenv('NODE_ENV') == 'production':
        raise SystemExit('Only --local is supported; no production or activation')
    folder = Path(__file__).resolve().parent.parent / 'validation/unisrec'
    folder.mkdir(parents=True,exist_ok=True)
    target = folder / 'UniSRec-FHCKM-300.pth'
    if target.exists():
        verify(target)
        print(json.dumps({'status':'verified_existing','bytes':SIZE,'sha256':SHA256}));return
    partial = target.with_suffix('.partial')
    count = 0
    with urllib.request.urlopen(SOURCE,timeout=45) as response, partial.open('wb') as output:
        while True:
            data = response.read(1024*1024)
            if not data:break
            count += len(data)
            if count > SIZE:raise ValueError('Checkpoint exceeds pinned size')
            output.write(data)
    verify(partial)
    partial.replace(target)
    print(json.dumps({'status':'downloaded_verified','bytes':SIZE,'sha256':SHA256,
                      'source':'official UniSRec README download folder',
                      'digestProvenance':'pinned from our first official download, not an author-published checksum'}))


if __name__ == '__main__':main()
