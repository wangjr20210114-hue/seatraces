import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from lib.ranking_diagnostic import row_features,metrics,grouped_rows,initial_score

def fixture():
    vector=[.2]*96+[.01]*512
    data={'posts':[{'features':vector},{'features':vector}],'profiles':[{'features':vector}]}
    row={'userId':'a','postId':'x','requestId':'r','parts':{'affinity':.5,'author':0,'city':0,'quality':.5,'fresh':.5,'seen':0,'tower':0,'coarse':1.7},
         'profile':0,'post':0,'userVector':[.2]*96,'itemVector':[.2]*96,'history':[1],'historyWindowEnds':[10],'at':20,'label':1,'grade':3}
    return row,data

class RankingDiagnosticTests(unittest.TestCase):
    def test_outcomes_identity_and_current_dwell_cannot_leak_into_features(self):
        row,data=fixture();before=row_features(row,data,True)
        row.update(label=0,grade=0,weight=500,userId='another',postId='another',requestId='another',visibleMs=120000,position=119,outcomes=[{'kind':'save'}])
        self.assertEqual(before,row_features(row,data,True))

    def test_future_history_rejected_and_empty_history_finite(self):
        row,data=fixture();row['historyWindowEnds']=[20]
        with self.assertRaisesRegex(ValueError,'Future'):row_features(row,data,True)
        row['history']=[];row['historyWindowEnds']=[]
        names,values=row_features(row,data,True)
        self.assertEqual(values[names.index('history_missing')],1)
        self.assertEqual(values[names.index('history_semantic_similarity')],0)

    def test_singleton_requests_have_no_per_request_ndcg(self):
        a,_=fixture();b={**a,'requestId':'r2','label':0,'grade':0}
        self.assertIsNone(metrics([a,b],[1,0],group_key='requestId')['ndcgAtK'])
        self.assertEqual(metrics([a,b],[1,0])['ndcgAtK'],1)
        self.assertEqual(metrics([a,b],[1,0],group_key='requestId')['singletonGroupsExcluded'],2)

    def test_grades_preserve_strength_and_group_order(self):
        a,_=fixture();b={**a,'grade':1};c={**a,'userId':'b'};d={**b,'userId':'b'}
        self.assertEqual(metrics([a,b],[0,1])['ndcgAtK'],1)
        self.assertLess(metrics([a,b],[0,1],'grade')['ndcgAtK'],1)
        rows,groups=grouped_rows([c,a,d,b]);self.assertEqual(groups,[2,2]);self.assertEqual(rows,[a,b,c,d])
        with self.assertRaises(ValueError):grouped_rows([a,c])

if __name__=='__main__':unittest.main()
