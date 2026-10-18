import copy
import importlib.util
import math
from pathlib import Path
import sys
import unittest
from unittest import mock
import tempfile
import torch

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT/'scripts'))
from lib.unisrec_model import AdaptedUniSRec, read_checkpoint, UniSRecCore
from experiment_unisrec import ranking_metrics, validate_input, peak_rss_mib
from analyze_unisrec import strata, paired_interval
import experiment_unisrec
torch.set_num_threads(2)


class UniSRecTests(unittest.TestCase):
    def test_padding_and_future_tokens_do_not_change_earlier_state(self):
        torch.manual_seed(7);model=UniSRecCore().eval()
        x=torch.randn(2,4,300);lengths=torch.tensor([1,3])
        y=model.encode_sequence(x,lengths)
        changed=x.clone();changed[0,1:]=1000;changed[1,3]=-1000
        self.assertTrue(torch.allclose(y,model.encode_sequence(changed,lengths),atol=1e-6))
        changed=x.clone();changed[1,0]+=torch.randn(300)
        self.assertFalse(torch.allclose(y[1],model.encode_sequence(changed,lengths)[1],atol=1e-5))
        with self.assertRaises(ValueError):model.encode_sequence(x,torch.tensor([0,3]))

    def test_actual_checkpoint_is_fully_loaded_and_only_unfrozen_parameters_change(self):
        state,report=read_checkpoint(ROOT/'validation/unisrec/UniSRec-FHCKM-300.pth')
        torch.manual_seed(9);model=AdaptedUniSRec(state).eval()
        for key,value in model.core.state_dict().items():self.assertTrue(torch.equal(value,state[key]),key)
        before=copy.deepcopy(model.state_dict())
        x=torch.randn(2,3,608);lens=torch.tensor([1,3]);item=torch.randn(2,608)
        output=model(x,lens,item)
        self.assertTrue(torch.isfinite(output).all())
        output.sum().backward()
        self.assertGreater(float(model.bridge[0].weight.grad.abs().sum()),0)
        torch.optim.SGD([p for p in model.parameters() if p.requires_grad],lr=.01).step()
        self.assertFalse(torch.equal(model.bridge[0].weight,before['bridge.0.weight']))
        for key,value in model.state_dict().items():
            if key.startswith(('core.trm_encoder.','core.position_embedding.')):self.assertTrue(torch.equal(value,before[key]),key)
        self.assertEqual(report['parameters'],sum(t.numel() for t in state.values()))

    def test_metrics_handle_multiple_acceptable_items_ties_and_unrated_groups(self):
        rows=[{'userId':'a','label':1},{'userId':'a','label':1},{'userId':'a','label':0},{'userId':'b','label':0}]
        value=ranking_metrics(rows,[1,1,0,10],2)
        self.assertEqual(value['groups'],1);self.assertEqual(value['ndcgAtK'],1);self.assertEqual(value['recallAtK'],1)
        with self.assertRaises(ValueError):ranking_metrics(rows,[1])
        self.assertGreater(peak_rss_mib(),0)

    def test_export_is_valid_and_future_history_or_partition_changes_are_rejected(self):
        import json
        data=json.loads((ROOT/'validation/unisrec/input.json').read_text())
        validate_input(data)
        changed=copy.deepcopy(data);row=next(r for r in changed['rows'] if r['history'])
        row['historyWindowEnds'][0]=row['at']
        with self.assertRaisesRegex(ValueError,'Future history'):validate_input(changed)
        changed=copy.deepcopy(data);row=next(r for r in changed['rows'] if r['partition']=='test');row['partition']='train'
        with self.assertRaisesRegex(ValueError,'embargo'):validate_input(changed)

    def test_missing_history_stratum_is_not_reported_as_a_zero_score(self):
        rows=[{'userId':str(i),'label':1,'history':[0]} for i in range(6)]
        split=strata(rows,[1]*6,[1]*6)
        self.assertIsNone(split['noMatureHistory']['model'])
        self.assertEqual(split['hasMatureHistory']['model']['ndcgAtK'],1)
        interval=paired_interval(rows,[1]*6,[1]*6)
        self.assertEqual(interval['low'],0);self.assertEqual(interval['high'],0)
        self.assertIsNone(paired_interval(rows[:4],[1]*4,[1]*4)['low'])
        with self.assertRaises(ValueError):strata(rows,[1],[1])

    def test_untrusted_file_and_production_or_activation_commands_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'unknown.pth';p.write_bytes(b'not the approved checkpoint')
            with mock.patch('torch.load') as loader:
                with self.assertRaisesRegex(ValueError,'digest mismatch'):read_checkpoint(p)
                loader.assert_not_called()
        for args,environment in [(['--real'],{}),(['--local','--activate'],{}),(['--local'],{'NODE_ENV':'production'})]:
            with mock.patch.object(sys,'argv',['experiment_unisrec.py',*args]),mock.patch.dict('os.environ',environment):
                with self.assertRaisesRegex(SystemExit,'Only --local'):experiment_unisrec.main()


if __name__=='__main__':unittest.main()
