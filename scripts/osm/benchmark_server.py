"""测量地点检索接口的响应时间和并发表现。"""
from concurrent.futures import ThreadPoolExecutor
import json
import math
from pathlib import Path
import statistics
import sys
import time

ROOT = Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0, str(ROOT / '.deps'))
import psycopg

CASES = [
    ('cn-short', '故宫', None), ('cn-suzhou', '拙政园', None),
    ('cn-common', '西湖', None), ('cn-bund', '外滩', None),
    ('tw', '台北101', None), ('jp', '東京タワー', None),
    ('kr', '경복궁', None), ('th-en', 'Grand Palace', None),
    ('vn-en', 'Hoan Kiem', None), ('sg-en', 'Marina Bay Sands', None),
    ('my-en', 'Petronas', None), ('mv-en', 'Malé', None),
    ('nearby-shanghai', '', (121.49, 31.24, 3000)),
    ('nearby-tokyo', '', (139.7454, 35.6586, 3000)),
]


def stats(values):
    ordered = sorted(values)
    return {'n': len(values), 'min_ms': round(min(values), 2),
            'p50_ms': round(statistics.median(values), 2),
            'p95_ms': round(ordered[math.ceil(len(values) * .95)-1], 2),
            'max_ms': round(max(values), 2)}


def query(conn, case):
    _, text, center = case
    started = time.perf_counter()
    if center:
        rows = conn.execute('SELECT id,name FROM osm.search_places(%s,center_lon=>%s,center_lat=>%s,radius_m=>%s,result_limit=>10)', (text, *center)).fetchall()
    else:
        rows = conn.execute('SELECT id,name FROM osm.search_places(%s,result_limit=>10)', (text,)).fetchall()
    return (time.perf_counter()-started)*1000, len(rows)


def worker(config, number):
    samples = []
    with psycopg.connect(**config, autocommit=True) as conn:
        for case in CASES * 2:
            elapsed, _ = query(conn, case)
            samples.append(elapsed)
    return samples


if __name__ == '__main__':
    config = json.loads((ROOT / 'reader.json').read_text())
    report = {'measured_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'scope': 'Server-local PostgreSQL read-only client; excludes phone, API and Internet latency. Warm-cache sample, not a capacity SLA.',
              'limit': 10, 'sequential': {}}
    with psycopg.connect(**config, autocommit=True) as conn:
        for case in CASES:
            first, count = query(conn, case)
            samples = [query(conn, case)[0] for _ in range(10)]
            report['sequential'][case[0]] = {'query': case[1], 'result_count': count, 'first_ms': round(first, 2), **stats(samples)}
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=2) as pool:
        batches = list(pool.map(lambda n: worker(config, n), range(2)))
    elapsed = time.perf_counter()-started
    samples = [value for batch in batches for value in batch]
    report['two_connections'] = {**stats(samples), 'wall_seconds': round(elapsed, 3), 'queries_per_second': round(len(samples)/elapsed, 2)}
    (ROOT / 'benchmark.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=True))
