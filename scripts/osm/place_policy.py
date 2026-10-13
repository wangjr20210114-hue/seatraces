"""Deterministic presentation rules. Source OSM rows are never overwritten."""
import re
import unicodedata
from datetime import datetime, timezone

COUNTRY_NAMES = {
    '中国':'CN','中國':'CN','CHINA':'CN','CHN':'CN',
    '日本':'JP','JAPAN':'JP','JPN':'JP','韩国':'KR','韓國':'KR','SOUTH KOREA':'KR','KOR':'KR',
    '台湾':'TW','臺灣':'TW','台灣':'TW','TAIWAN':'TW','TWN':'TW',
    '香港':'HK','HONG KONG':'HK','HKG':'HK','澳门':'MO','澳門':'MO','MACAO':'MO','MACAU':'MO','MAC':'MO',
    '泰国':'TH','ไทย':'TH','THAILAND':'TH','THA':'TH','越南':'VN','VIETNAM':'VN','VIET NAM':'VN','VNM':'VN',
    '马来西亚':'MY','MALAYSIA':'MY','MYS':'MY','新加坡':'SG','SINGAPORE':'SG','SGP':'SG',
    '文莱':'BN','BRUNEI':'BN','BRN':'BN','马尔代夫':'MV','MALDIVES':'MV','MDV':'MV',
}

def clean_text(value):
    if not isinstance(value,str): return None
    value=' '.join(unicodedata.normalize('NFKC',value).split())
    return value or None

def country_code(value):
    value=clean_text(value)
    if not value:return None
    value=value.upper()
    if ';' in value:
        parts=[country_code(part) for part in value.split(';')]
        return parts[0] if all(parts) and len(set(parts))==1 else None
    return value if re.fullmatch('[A-Z]{2}',value) else COUNTRY_NAMES.get(value)

def display_name(value,tags):
    return next((v for v in (clean_text(x) for x in [value,tags.get('name:zh-Hans'),tags.get('name:zh'),tags.get('name'),tags.get('name:en'),tags.get('brand')]) if v),None)

def stamp(value):
    if not value:return None
    try:
        value=value if isinstance(value,datetime) else datetime.fromisoformat(str(value).replace('Z','+00:00'))
        return value if value.tzinfo else None
    except (TypeError,ValueError):return None

def fact_status(data,now=None):
    now=now or datetime.now(timezone.utc)
    evidence=data.get('evidence') or {}
    status='evidence_reviewed' if evidence.get('reviewStatus')=='accepted' else 'source_reported'
    for key in ('reviewAfter','validThrough','validFrom'):
        if not evidence.get(key):continue
        d=stamp(evidence[key])
        if d is None or (key=='validFrom' and d>now) or (key!='validFrom' and d<=now):return 'needs_review'
    return status

def select_fact(records,now=None):
    """Applicable reviewed evidence outranks legacy notes; publication, not ingest, wins.

    If the latest reviewed publication has expired, keep it pending review instead
    of resurrecting an older rule. All source records remain in place_facts.
    """
    if not records:return None
    now=now or datetime.now(timezone.utc)
    reviewed=[r for r in records if (r.get('evidence') or {}).get('reviewStatus')=='accepted']
    pool=reviewed or records
    # A future announcement must not hide the currently applicable rule.
    current=[r for r in pool if not stamp((r.get('evidence') or {}).get('validFrom')) or stamp(r['evidence']['validFrom'])<=now]
    floor=datetime.min.replace(tzinfo=timezone.utc)
    return max(current or pool,key=lambda r:(stamp(r.get('source_timestamp')) or floor,stamp(r.get('recorded_at')) or floor,str(r.get('id',''))))
