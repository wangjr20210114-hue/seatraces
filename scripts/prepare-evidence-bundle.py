"""从已获取的官方页面中整理地点资料片段。"""
from pathlib import Path
from datetime import datetime,timezone
import hashlib,json
ROOT=Path(__file__).resolve().parents[1]
DIRECTORY=ROOT/'.runtime/evidence-20261011'
def text(name):return (DIRECTORY/(name+'.txt')).read_text(encoding='utf-8-sig')
def section(s,start,end):
    a=s.index(start);b=s.index(end,a+len(start));return s[a:b].strip()
def source(name,url,publisher,published,precision):
    p=DIRECTORY/(name+'.html')
    return dict(url=url,publisher=publisher,publishedAt=published,publishedPrecision=precision,
      retrievedAt=datetime.fromtimestamp(p.stat().st_mtime,timezone.utc).isoformat(),
      sha256=hashlib.sha256(p.read_bytes()).hexdigest(),scope='ordinary_published_rules; temporary notices and live availability require recheck')
hours=source('hours','https://ylj.suzhou.gov.cn/szsylj/kfsj/wztt.shtml','苏州市园林和绿化管理局','2025-01-09T16:33:00+08:00','minute')
prices=source('prices','https://ylj.suzhou.gov.cn/szsylj/mpjg/wztt.shtml','苏州市园林和绿化管理局','2024-07-11T09:07:00+08:00','minute')
museum=source('museum-guide','https://www.szmuseum.com/News/Index/OpenGuide','苏州博物馆','2025-01-08T00:00:00+08:00','day')
h=text('hours');p=text('prices');m=text('museum-guide')
places=[]
for name,place_id,start,end in [('拙政园','osm:way/468359738','苏州市拙政园管理处','环秀山庄'),('留园','osm:way/420034522','苏州市留园管理处','网师园')]:
    price_excerpt=section(p,'序号\n景(区)点名称','4\n狮子林')
    places.append(dict(name=name,placeId=place_id,expectedFacts=3,evidence=[
      dict(hours,id=name+'-hours',fields=['openingHours','lastEntry'],text=section(h,start,end)),
      dict(prices,id=name+'-prices',fields=['ticketPrice'],text=price_excerpt)]))
places.append(dict(name='苏州博物馆本馆',placeId='osm:way/542534202',expectedFacts=4,evidence=[
  dict(museum,id='museum-opening',fields=['openingHours','lastEntry'],text=section(m,'第一条  苏州博物馆开放时间','第二条')),
  dict(museum,id='museum-phone',fields=['phone'],text=section(m,'第三条  咨询电话','第四条')),
  dict(museum,id='museum-reservation',fields=['reservation'],text=section(m,'第五条  预约参观','第八条 新闻媒体'))]))
(DIRECTORY/'bundle.json').write_text(json.dumps(dict(places=places),ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps({'places':len(places),'expectedFacts':10,'sourceFiles':3}))
