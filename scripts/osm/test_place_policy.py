import unittest
from datetime import datetime,timezone
from place_policy import country_code,display_name,select_fact,fact_status
class PolicyTests(unittest.TestCase):
 def test_source_name_and_country_rules(self):
  self.assertEqual(display_name(' ',{'name:zh-Hans':' ','name':'丹坑'}),'丹坑')
  for source in ['ไทย','Thailand','Thailand;ไทย',' th ']:self.assertEqual(country_code(source),'TH')
  for source in ['country','北七家院区','Thailand;Vietnam']:self.assertIsNone(country_code(source))
 def test_publication_date_beats_ingest_and_future_announcement(self):
  def f(source,ingest,**e):return dict(source_timestamp=source,recorded_at=ingest,evidence={'reviewStatus':'accepted',**e})
  a=f('2026-01-01T00:00:00Z','2026-10-11T00:00:00Z');b=f('2026-02-01T00:00:00Z','2026-10-10T00:00:00Z')
  future=f('2026-03-01T00:00:00Z','2026-10-11T00:00:00Z',validFrom='2026-12-01T00:00:00Z')
  now=datetime(2026,10,11,tzinfo=timezone.utc)
  self.assertIs(select_fact([a,b,future],now),b)
  b['evidence']['reviewAfter']='2026-10-10T00:00:00Z'
  self.assertEqual(fact_status(select_fact([a,b],now),now),'needs_review')
if __name__=='__main__':unittest.main()
