import sys
from pathlib import Path
import unittest
import torch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'scripts'))
from lib.travel_rankers import DINRanker, DCNv2Ranker, MatrixCross
from experiment_travel_rankers import batch_inputs
from experiment_unisrec import validate_input
import json
import copy


class RankerTests(unittest.TestCase):
    def test_empty_and_padding_are_finite_and_invariant(self):
        torch.manual_seed(4)
        for kind in [DINRanker,DCNv2Ranker]:
            with self.subTest(kind=kind.__name__):
                model=kind(features=8,width=4).eval()
                u,c,h=torch.randn(3,8),torch.randn(3,8),torch.randn(3,4,8)
                mask=torch.tensor([[False]*4,[True,False,False,False],[True,True,False,False]])
                a=model(u,c,h,mask);changed=h.clone();changed[~mask]=99
                b=model(u,c,changed,mask)
                self.assertTrue(torch.isfinite(a).all())
                torch.testing.assert_close(a,b)
                a.sum().backward()
                self.assertTrue(all(p.grad is None or torch.isfinite(p.grad).all() for p in model.parameters()))

    def test_cross_layer_matches_matrix_equation(self):
        layer=MatrixCross(3);x0=torch.tensor([[1.,2.,3.]]);x=torch.tensor([[3.,4.,5.]])
        torch.testing.assert_close(layer(x0,x),x0*(x@layer.linear.weight.T+layer.linear.bias)+x)

    def test_masks_preserve_history_identity(self):
        items=torch.arange(24,dtype=torch.float32).reshape(3,8);profiles=items.clone()
        rows=[{'profile':0,'post':2,'history':[]},{'profile':1,'post':0,'history':[2,1]}]
        u,c,h,mask=batch_inputs(rows,items,profiles)
        self.assertEqual(mask.tolist(),[[False,False],[True,True]])
        torch.testing.assert_close(h[1],items[[2,1]])
        torch.testing.assert_close(c,items[[2,0]])

    def test_frozen_input_rejects_future_outcomes(self):
        source=Path(__file__).resolve().parent.parent/'validation/unisrec/input.json'
        data=json.loads(source.read_text());validate_input(data)
        broken=copy.deepcopy(data)
        row=next(r for r in broken['rows'] if r['history'])
        row['historyWindowEnds'][0]=row['at']
        with self.assertRaisesRegex(ValueError,'Future history leakage'):validate_input(broken)


if __name__=='__main__':unittest.main()
