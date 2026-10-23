"""下载故宫相关官方资料，整理来源与正文。"""
from pathlib import Path
from datetime import datetime, timezone
from html.parser import HTMLParser
from concurrent.futures import ThreadPoolExecutor
import hashlib, json, urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.runtime/palace-evidence-20261012'
SOURCES = {
    'guide': 'https://www.dpm.org.cn/gesture.html',
    'visit': 'https://www.dpm.org.cn/Visit.html',
    'booking': 'https://www.dpm.org.cn/subject_booking/',
    'taihe': 'https://www.dpm.org.cn/explore/building/236465.html',
    'baohe': 'https://www.dpm.org.cn/explore/building/236434.html',
    'zhonghe': 'https://www.dpm.org.cn/explore/building/236464.html',
}

class Text(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.skip = [], 0
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style', 'noscript'): self.skip += 1
        if tag in ('p','div','br','li','tr','td','h1','h2','h3','h4'): self.parts.append('\n')
    def handle_endtag(self, tag):
        if tag in ('script','style','noscript') and self.skip: self.skip -= 1
        if tag in ('p','div','li','tr','td','h1','h2','h3','h4'): self.parts.append('\n')
    def handle_data(self, value):
        if not self.skip: self.parts.append(value)

def download(item):
    key, url = item
    req = urllib.request.Request(url, headers={'User-Agent':'SeaTraces evidence research/1.0'})
    with urllib.request.urlopen(req, timeout=25) as response:
        if response.geturl().split('/')[2] != 'www.dpm.org.cn': raise ValueError('Unexpected source redirect')
        body = response.read(2_000_001)
        if len(body)>2_000_000: raise ValueError('Source too large')
        parser = Text(); parser.feed(body.decode('utf-8'))
        text = '\n'.join(line.strip() for line in ''.join(parser.parts).splitlines() if line.strip())
        if len(text)<100: raise ValueError('Missing source text')
        (OUT/(key+'.html')).write_bytes(body)
        (OUT/(key+'.txt')).write_text(text,encoding='utf8')
        return dict(id=key,url=url,publisher='故宫博物院',retrievedAt=datetime.now(timezone.utc).isoformat(),
                    publishedAt=None,sha256=hashlib.sha256(body).hexdigest(),textHash=hashlib.sha256(text.encode()).hexdigest(),
                    bytes=len(body),textFile=key+'.txt',scope='Official page fetched now; publication date and live availability not inferred')

if __name__ == '__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with ThreadPoolExecutor(max_workers=2) as executor: sources=list(executor.map(download,SOURCES.items()))
    (OUT/'sources.json').write_text(json.dumps(sources,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'sources':len(sources),'bytes':sum(x['bytes'] for x in sources)}))
