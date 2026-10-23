"""分析 UniSRec 离线实验结果和分组指标。"""
import hashlib
import json
import os
from pathlib import Path
import random
import sys
import time
import torch
from experiment_unisrec import ROOT, baseline_scores, ranking_metrics, predict, validate_input, peak_rss_mib
from lib.unisrec_model import AdaptedUniSRec


def strata(rows, scores, baseline):
    if len(rows) != len(scores) or len(rows) != len(baseline):
        raise ValueError('Score alignment mismatch')
    result = {}
    for name, predicate in [('noMatureHistory', lambda r: not r['history']),
                            ('hasMatureHistory', lambda r: bool(r['history']))]:
        selected = [i for i, row in enumerate(rows) if predicate(row)]
        group = [rows[i] for i in selected]
        result[name] = {'rows': len(group), 'users': len({r['userId'] for r in group}),
                        'model': ranking_metrics(group, [scores[i] for i in selected]) if group else None,
                        'baseline': ranking_metrics(group, [baseline[i] for i in selected]) if group else None}
    return result


def paired_interval(rows, scores, baseline, repeats=2000):
    if len(rows) != len(scores) or len(rows) != len(baseline):
        raise ValueError('Score alignment mismatch')
    groups = {}
    for i, row in enumerate(rows):
        groups.setdefault(row['userId'], []).append(i)
    differences = []
    for indexes in groups.values():
        group = [rows[i] for i in indexes]
        if not any(r['label'] for r in group):
            continue
        differences.append(ranking_metrics(group, [scores[i] for i in indexes])['ndcgAtK'] -
                           ranking_metrics(group, [baseline[i] for i in indexes])['ndcgAtK'])
    result = {'users': len(differences), 'mean': sum(differences)/len(differences) if differences else None,
              'low': None, 'high': None, 'method': 'paired user bootstrap; diagnostic 95% interval',
              'seed': 20261018, 'repeats': repeats}
    if len(differences) >= 5:
        rng = random.Random(20261018)
        means = sorted(sum(rng.choices(differences, k=len(differences)))/len(differences) for _ in range(repeats))
        result.update(low=means[int(repeats*.025)], high=means[int(repeats*.975)])
    return result


def main():
    if sys.argv[1:] != ['--local'] or os.getenv('NODE_ENV') == 'production':
        raise SystemExit('Only --local is allowed; no production or activation')
    target = ROOT/'analysis.json'
    if target.exists():
        raise RuntimeError('Analysis exists; preserve prior evidence')
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    torch.use_deterministic_algorithms(True)
    started = time.monotonic()
    raw = (ROOT/'report.json').read_bytes()
    report = json.loads(raw)
    if report.get('status') != 'completed' or report.get('activationAllowed') is not False:
        raise ValueError('A completed offline report is required')
    source = (ROOT/'input.json').read_bytes()
    if hashlib.sha256(source).hexdigest() != report['inputSha256']:
        raise ValueError('Input changed after training')
    for name, field in [('experiment_unisrec.py', 'programSha256'), ('lib/unisrec_model.py', 'coreSha256')]:
        if hashlib.sha256((Path(__file__).parent/name).read_bytes()).hexdigest() != report[field]:
            raise ValueError('Training implementation changed after training')
    data = json.loads(source)
    validate_input(data)
    selection = json.loads((ROOT/'selection.json').read_text())
    checkpoint = torch.load(ROOT/'selected.pt', map_location='cpu', weights_only=True)
    if (checkpoint.get('activationAllowed') is not False or checkpoint['configuration'] != selection['configuration']
        or checkpoint['epoch'] != selection['epoch'] or checkpoint['inputSha256'] != report['inputSha256']
        or selection['configuration']['name'] != report['selected']['name']):
        raise ValueError('Frozen winner identity mismatch')
    model = AdaptedUniSRec()
    model.load_state_dict(checkpoint['state_dict'], strict=True)
    items = torch.tensor([p['features'] for p in data['posts']], dtype=torch.float32)
    profiles = torch.tensor([p['features'] for p in data['profiles']], dtype=torch.float32)
    result = {'scope': data['scope'], 'activationAllowed': False, 'trainingChanged': False,
              'reportSha256': hashlib.sha256(raw).hexdigest(), 'inputSha256': report['inputSha256'],
              'weightsSha256': hashlib.sha256((ROOT/'selected.pt').read_bytes()).hexdigest(),
              'selected': report['selected']['name'], 'partitions': {}}
    for name in ['validation', 'test']:
        rows = [r for r in data['rows'] if r['partition'] == name]
        scores = predict(model, rows, items, profiles)
        baseline = baseline_scores(rows, data)
        measured = ranking_metrics(rows, scores)
        if abs(measured['ndcgAtK']-report['selected'][name]['ndcgAtK']) > 1e-8:
            raise ValueError('Frozen model replay differs')
        result['partitions'][name] = {'strata': strata(rows, scores, baseline),
                                      'pairedInterval': paired_interval(rows, scores, baseline)}
    result['elapsedSeconds'] = round(time.monotonic()-started, 2)
    result['peakRssMiB'] = peak_rss_mib()
    result['limitations'] = ['No independent new test data; previously inspected synthetic labels.',
                            'User-pooled diagnostic ranks; not per-request production ranking.',
                            'No mature history does not necessarily mean a newly registered user.',
                            'An empty stratum is unavailable evidence, not a zero score.']
    target.write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
