"""Read-only live regression of the new catalog against the full server database."""
from datetime import datetime, timezone
import json
from pathlib import Path
import time
from place_service import Gateway, ROOT

g=Gateway(json.loads((ROOT/'reader.json').read_text()))
report={'time':datetime.now(timezone.utc).isoformat(),'scope':'full server database, read-only new catalog queries','checks':[]}
def check(name,params,expected=None):
    t=time.perf_counter()
    try:
        result=g.get('/places',{k:[str(v)] for k,v in params.items()})
        assert result['items'], 'Expected at least one result'
        if expected: assert result['items'][0]['id']==expected, 'Expected landmark ranked first'
        report['checks'].append({'name':name,'passed':True,'ms':round((time.perf_counter()-t)*1000,2),'first':result['items'][0],'count':len(result['items'])})
    except Exception as e:
        report['checks'].append({'name':name,'passed':False,'error':type(e).__name__,'sqlstate':getattr(e,'sqlstate',None),'message':str(e) if isinstance(e,AssertionError) else 'Query failed; inspect locally'})

check('tokyo_simplified',{'q':'东京塔'},'osm:relation/4247312')
check('tokyo_english',{'q':'Tokyo Tower'},'osm:relation/4247312')
check('bund',{'q':'外滩','region':'china'})
check('taipei',{'q':'台北101','region':'taiwan'})
check('palace',{'q':'경복궁','region':'south-korea'})
check('tokyo_accommodation',{'q':'','category':'accommodation','lng':139.7454,'lat':35.6586,'radius':3000})
check('tokyo_hostels',{'q':'','category':'accommodation','subcategory':'hostel','lng':139.7454,'lat':35.6586,'radius':10000})
check('shanghai_scenic',{'q':'','category':'scenic','lng':121.49,'lat':31.24,'radius':3000})
report['coverage']=g.get('/coverage',{})
report['passed']=sum(c['passed'] for c in report['checks'])
report['failed']=len(report['checks'])-report['passed']
(ROOT/'catalog-test-20261011.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str),encoding='utf8')
print(json.dumps({'passed':report['passed'],'failed':report['failed'],'checks':[{'name':c['name'],'passed':c['passed'],'ms':c.get('ms'),'error':c.get('error'),'sqlstate':c.get('sqlstate'),'first':c.get('first',{}).get('name')} for c in report['checks']]},ensure_ascii=True,indent=2))
raise SystemExit(1 if report['failed'] else 0)
