"""下载 OSM 地区数据，支持断点续传和校验。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
from urllib.request import Request, urlopen

REGIONS = {
    "china": "asia/china",
    "taiwan": "asia/taiwan",
    "shanghai": "asia/china/shanghai",
    "jiangsu": "asia/china/jiangsu",
    "zhejiang": "asia/china/zhejiang",
    "japan": "asia/japan",
    "south-korea": "asia/south-korea",
    "thailand": "asia/thailand",
    "vietnam": "asia/vietnam",
    "malaysia-singapore-brunei": "asia/malaysia-singapore-brunei",
    "maldives": "asia/maldives",
}
BASE = "https://download.geofabrik.de/"
UA = "SeaTraces-OSM/0.2 (educational travel place index)"


def emit(event, **data):
    print(json.dumps({"event": event, **data}, ensure_ascii=True), flush=True)


def request(url, headers=None, method=None):
    return urlopen(Request(url, headers={"User-Agent": UA, **(headers or {})}, method=method), timeout=60)


def digest(file, algorithm):
    h = hashlib.new(algorithm)
    with open(file, "rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def remote_checksum(url):
    with request(url + ".md5") as response:
        text = response.read(1024).decode("ascii")
    match = re.match(r"^([a-fA-F0-9]{32})\s", text)
    if not match:
        raise ValueError("Invalid official MD5 response")
    return match[1].lower()


def download(region, root, reserve_gib=12, max_file_gib=5):
    url = BASE + REGIONS[region] + "-latest.osm.pbf"
    root.mkdir(parents=True, exist_ok=True)
    expected = remote_checksum(url)
    with request(url, method="HEAD") as response:
        size = int(response.headers["Content-Length"])
        modified = response.headers.get("Last-Modified")
    if size <= 0 or size > max_file_gib * 1024**3:
        raise ValueError("Extract exceeds per-file size allowance")
    name = f"{region}-{expected}.osm.pbf"
    destination = root / name
    partial = root / (name + ".part")
    if destination.exists() and digest(destination, "md5") == expected:
        emit("already_verified", region=region, path=str(destination))
    else:
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > size:
            raise ValueError("Partial file is larger than source; inspect it before retrying")
        if shutil.disk_usage(root).free < size - offset + reserve_gib * 1024**3:
            raise RuntimeError("Insufficient space after retaining the requested disk reserve")
        last_log = 0.0
        while offset < size:
            start = offset
            end = min(offset + 32 * 1024 * 1024 - 1, size - 1)
            headers = {"Range": f"bytes={offset}-{end}"}
            with request(url, headers) as response:
                if response.status != 206:
                    raise RuntimeError("Server did not honour resume; partial file preserved")
                if response.headers.get("Content-Range", "") != f"bytes {start}-{end}/{size}":
                    raise RuntimeError("Unexpected Content-Range")
                with open(partial, "ab" if offset else "wb") as target:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        offset += len(chunk)
                        if offset > end + 1:
                            raise RuntimeError("Response exceeded advertised size")
                        target.write(chunk)
                        if time.monotonic() - last_log > 15:
                            if shutil.disk_usage(root).free < reserve_gib * 1024**3:
                                raise RuntimeError("Disk reserve reached; resume after freeing space")
                            emit("downloading", region=region, bytes=offset, total=size, percent=round(offset * 100 / size, 1))
                            last_log = time.monotonic()
                    target.flush()
                    os.fsync(target.fileno())
            if offset == start:
                raise RuntimeError("Empty download response; partial file preserved")
        if partial.stat().st_size != size:
            raise RuntimeError("Incomplete response; downloaded bytes preserved for resume")
        if digest(partial, "md5") != expected:
            raise RuntimeError("Checksum mismatch; partial retained for diagnosis, not accepted")
        partial.replace(destination)
    result = {
        "region": region, "path": name, "source_url": url,
        "bytes": size, "md5": expected, "sha256": digest(destination, "sha256"),
        "http_last_modified": modified, "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "attribution": "© OpenStreetMap contributors", "license": "ODbL-1.0",
        "license_url": "https://www.openstreetmap.org/copyright", "verified": True,
    }
    manifest = root / f"{region}-manifest.json"
    temporary = manifest.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf8")
    temporary.replace(manifest)
    emit("verified", **result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("regions", nargs="+", choices=REGIONS)
    parser.add_argument("--directory", type=Path, default=Path("data/osm/raw"))
    parser.add_argument("--reserve-gib", type=float, default=12)
    parser.add_argument("--max-file-gib", type=float, default=5)
    args = parser.parse_args()
    if args.reserve_gib < 2 or args.max_file_gib <= 0:
        parser.error("Retain at least 2 GiB; max file size must be positive")
    for region in args.regions:
        for attempt in range(3):
            try:
                download(region, args.directory.resolve(), args.reserve_gib, args.max_file_gib)
                break
            except Exception as error:
                emit("error", region=region, attempt=attempt + 1, message=str(error))
                if attempt == 2:
                    raise SystemExit(1)
                time.sleep(3 * (attempt + 1))
