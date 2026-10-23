"""检查实际运行的地点查询服务。"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

ROOT = Path('/home/ubuntu/seatraces-osm')
sys.path.insert(0, str(ROOT / '.deps'))
import psycopg
from psycopg.rows import dict_row
from benchmark_server import CASES, query, stats


def run():
    config = json.loads((ROOT / 'reader.json').read_text())
    report = {'measured_at': datetime.now(timezone.utc).isoformat(),
              'scope': 'Live server-local read-only SQL; excludes HTTP/mobile/network; no cache reset.',
              'checks': [], 'samples': {}, 'benchmark': {}, 'observations': []}

    def check(label, function):
        started = time.perf_counter()
        try:
            detail = function()
            report['checks'].append({'name': label, 'passed': True,
                                     'elapsed_ms': round((time.perf_counter()-started)*1000, 2),
                                     'detail': detail})
        except Exception as error:
            report['checks'].append({'name': label, 'passed': False,
                                     'error_type': type(error).__name__,
                                     'sqlstate': getattr(error, 'sqlstate', None),
                                     'message': str(error) if isinstance(error, AssertionError) else 'Query/check failed; inspect on server.'})

    def require(condition, message):
        if not condition:
            raise AssertionError(message)

    with psycopg.connect(**config, autocommit=True, row_factory=dict_row) as conn:
        report['database'] = conn.execute("SELECT current_database() AS name,current_user AS role,version(),current_setting('statement_timeout') AS timeout,current_setting('default_transaction_read_only') AS read_only,pg_database_size(current_database()) AS bytes").fetchone()
        report['active_imports'] = conn.execute('SELECT i.region,i.rows_count,i.pbf_timestamp FROM osm.imports i JOIN osm.active_imports a ON a.import_id=i.id ORDER BY i.region').fetchall()

        def coverage():
            expected = {'china','taiwan','japan','south-korea','thailand','vietnam','malaysia-singapore-brunei','maldives'}
            require({x['region'] for x in report['active_imports']} == expected, 'Active region set changed')
            require(all(x['rows_count'] > 0 for x in report['active_imports']), 'Empty active snapshot')
            return {'regions': len(expected), 'manifest_rows': sum(x['rows_count'] for x in report['active_imports']), 'count_scope': 'Imported manifest counts, not a fresh full-table count'}
        check('active_region_coverage', coverage)

        def permissions():
            result = conn.execute("SELECT has_table_privilege(current_user,'osm.poi','SELECT') AS can_read,has_table_privilege(current_user,'osm.poi','INSERT') AS can_insert,has_table_privilege(current_user,'osm.poi','UPDATE') AS can_update,has_table_privilege(current_user,'osm.poi','DELETE') AS can_delete,has_schema_privilege(current_user,'osm','CREATE') AS can_create").fetchone()
            require(result['can_read'] and not any(result[k] for k in ('can_insert','can_update','can_delete','can_create')), 'Reader privileges differ from least privilege')
            require(report['database']['read_only'] == 'on', 'Default read-only is disabled')
            return result
        check('reader_privileges', permissions)

        def indexes():
            result = conn.execute("SELECT c.relname,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='osm'").fetchall()
            require(bool(result) and all(x['indisvalid'] and x['indisready'] for x in result), 'Invalid or unfinished index')
            return result
        check('indexes_valid', indexes)

        def search(text, category=None, center=None, limit=10):
            lon, lat, radius = center or (None, None, 10000)
            rows = conn.execute('SELECT * FROM osm.search_places(%s,%s,%s,%s,%s,%s)', (text,category,lon,lat,radius,limit)).fetchall()
            require(len(rows) <= limit and len({x['id'] for x in rows}) == len(rows), 'Result limit or ID deduplication violated')
            require(all(-180 <= x['lon'] <= 180 and -90 <= x['lat'] <= 90 for x in rows), 'Invalid result coordinates')
            require(all(x['source_timestamp'] is not None for x in rows), 'Missing source snapshot')
            if category:
                require(all(x['category'] == category for x in rows), 'Category filter violated')
            if center:
                require(all(x['distance_m'] is not None and 0 <= x['distance_m'] <= radius+0.01 for x in rows), 'Nearby radius violated')
            if rows:
                flags = conn.execute('SELECT bool_and(p.selectable) AS selectable FROM osm.poi p JOIN osm.active_imports a ON a.import_id=p.import_id WHERE p.id=ANY(%s)', ([x['id'] for x in rows],)).fetchone()
                require(flags['selectable'], 'Restricted place returned')
            return rows

        for label, text, center in CASES:
            def name_case(label=label, text=text, center=center):
                rows = search(text, center=center)
                report['samples'][label] = rows
                require(bool(rows), 'Known name/nearby search returned no results')
                return {'count':len(rows),'first_name':rows[0]['name'],'first_category':rows[0]['category']}
            check('search_'+label, name_case)

        for label, category, center in [
            ('shanghai_attractions','attraction',(121.49,31.24,3000)),
            ('tokyo_accommodation','accommodation',(139.7454,35.6586,3000)),
            ('singapore_food','food',(103.859,1.286,3000)),
        ]:
            def category_case(label=label, category=category, center=center):
                rows = search('', category, center)
                report['samples'][label] = rows
                require(bool(rows), 'Category nearby search returned no results')
                require([x['distance_m'] for x in rows] == sorted(x['distance_m'] for x in rows), 'Empty-name nearby results not sorted by distance')
                return {'count':len(rows)}
            check(label, category_case)

        def tokyo_landmark():
            rows = search('Tokyo Tower','attraction',(139.7454,35.6586,1000))
            report['samples']['tokyo_landmark_filtered'] = rows
            require(any(x['id']=='osm:relation/4247312' for x in rows), 'Expected mapped Tokyo Tower object absent from filtered results')
            return {'count':len(rows),'first':rows[0]['name']}
        check('tokyo_landmark_filtered', tokyo_landmark)

        bad_inputs = [
            ('empty_name_without_center',('',None,None,None,10000,10)),
            ('single_character_without_center',('湖',None,None,None,10000,10)),
            ('overlong_query',('x'*121,None,None,None,10000,10)),
            ('zero_limit',('外滩',None,None,None,10000,0)),
            ('excess_limit',('外滩',None,None,None,10000,101)),
            ('missing_latitude',('',None,121.49,None,3000,10)),
            ('invalid_longitude',('',None,181,31.24,3000,10)),
            ('invalid_latitude',('',None,121.49,91,3000,10)),
            ('negative_radius',('',None,121.49,31.24,-1,10)),
        ]
        for label, args in bad_inputs:
            def reject(args=args):
                try:
                    conn.execute('SELECT * FROM osm.search_places(%s,%s,%s,%s,%s,%s)',args).fetchall()
                except psycopg.errors.RaiseException:
                    return {'rejected':True}
                raise AssertionError('Invalid input accepted')
            check(label,reject)

        def literal_query():
            rows = search("' OR 1=1 --",center=(121.49,31.24,1000))
            require(not rows,'SQL-like literal unexpectedly matched places')
            return {'count':len(rows)}
        check('sql_like_text_is_literal',literal_query)
        for text in ('东京塔','Tokyo Tower','東京タワー','MALÉ'):
            try:
                rows = search(text)
                report['observations'].append({'query':text,'count':len(rows),'top':[{'id':x['id'],'name':x['name'],'category':x['category'],'lon':x['lon'],'lat':x['lat']} for x in rows[:3]]})
            except psycopg.Error as error:
                report['observations'].append({'query':text,'sqlstate':error.sqlstate})

    with psycopg.connect(**config, autocommit=True) as conn:
        for case in CASES:
            def benchmark(case=case):
                first,count=query(conn,case)
                elapsed=[query(conn,case)[0] for _ in range(10)]
                value={'first_ms':round(first,2),'count':count,**stats(elapsed)}
                report['benchmark'][case[0]]=value
                return value
            check('benchmark_'+case[0],benchmark)

    def parallel():
        def worker(_):
            with psycopg.connect(**config,autocommit=True) as conn:
                return [query(conn,case)[0] for case in CASES*2]
        started=time.perf_counter()
        with ThreadPoolExecutor(max_workers=2) as pool:
            samples=[x for batch in pool.map(worker,range(2)) for x in batch]
        report['two_connections']={**stats(samples),'wall_seconds':round(time.perf_counter()-started,3)}
        return report['two_connections']
    check('two_connections',parallel)
    report['passed']=sum(x['passed'] for x in report['checks'])
    report['failed']=len(report['checks'])-report['passed']
    report['completed_at']=datetime.now(timezone.utc).isoformat()
    target=ROOT/('live-test-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
    target.write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str))
    print('SEATRACES LIVE DB TEST',report['completed_at'])
    print('Checks:',report['passed'],'PASS /',report['failed'],'FAIL')
    for item in report['checks']:
        if not item['passed']: print('FAIL',item['name'],item.get('message'),item.get('sqlstate'))
    print('QUERY | FIRST ms | P50 ms | P95 ms')
    for label,value in report['benchmark'].items():
        print(label,value['first_ms'],value['p50_ms'],value['p95_ms'])
    print('2 connections:',report.get('two_connections'))
    print('REPORT:',target)
    return report


if __name__=='__main__':
    run()
