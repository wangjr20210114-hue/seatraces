"""提取排序诊断特征，计算效果指标和置信区间。"""
import ctypes
import math
import os
import random
import sys
import numpy as np

def cosine(a,b):
    a=np.asarray(a,dtype=float);b=np.asarray(b,dtype=float)
    return float(a@b/max(1e-12,np.linalg.norm(a)*np.linalg.norm(b)))

def initial_score(row):
    p=row['parts']
    return 3*p['affinity']+.25*p['author']+.7*p['city']+.45*p['quality']+.2*p['fresh']-.8*p['seen']+p['tower']

def row_features(row,data,rich):
    p=row['parts']
    names=['rule_margin','affinity','coarse','author','fresh','quality','city','seen']
    values=[initial_score(row)]+[p[k] for k in names[1:]]
    if rich:
        u=np.asarray(data['profiles'][row['profile']]['features']);v=np.asarray(data['posts'][row['post']]['features'])
        if len(u)!=608 or len(v)!=608:raise ValueError('Unexpected feature dimension')
        u0=np.asarray(row['userVector']);v0=np.asarray(row['itemVector'])
        names+=['semantic_similarity','history_semantic_similarity','history_structured_similarity','history_size','history_missing']
        if len(row['history'])!=len(row['historyWindowEnds']) or any(t>=row['at'] for t in row['historyWindowEnds']):raise ValueError('Future history')
        if len(row['history'])>20:raise ValueError('History bound')
        if row['history']:
            w=np.asarray([2**(-(row['at']-t)/(7*86400000)) for t in row['historyWindowEnds']])
            h=np.average([data['posts'][i]['features'] for i in row['history']],axis=0,weights=w)
            hs,ht=cosine(h[96:],v[96:]),cosine(h[:96],v[:96])
        else:hs=ht=0
        values += [cosine(u[96:],v[96:]),hs,ht,len(row['history'])/20,not bool(row['history'])]
        names += ['product_'+str(i) for i in range(96)]+['difference_'+str(i) for i in range(96)]
        values += (u0*v0).tolist()+np.abs(u0-v0).tolist()
    if not all(math.isfinite(float(v)) for v in values):raise ValueError('Nonfinite feature')
    return names,values

def metrics(rows,scores,target='label',group_key='userId',k=10):
    if len(rows)!=len(scores) or any(not math.isfinite(float(s)) for s in scores):raise ValueError('Prediction mismatch')
    grouped={}
    for row,score in zip(rows,scores):grouped.setdefault(row[group_key],[]).append((row,float(score)))
    values=[];singleton=0
    for pairs in grouped.values():
        if len(pairs)<2:singleton+=1;continue
        ideal=sorted((r[target] for r,_ in pairs),reverse=True)[:k]
        idcg=sum(g/math.log2(i+2) for i,g in enumerate(ideal))
        if idcg<=0:continue
        ranked=sorted(pairs,key=lambda x:-x[1])[:k]
        values.append(sum(r[target]/math.log2(i+2) for i,(r,_) in enumerate(ranked))/idcg)
    return {'ndcgAtK':float(np.mean(values)) if values else None,'groups':len(values),'singletonGroupsExcluded':singleton,'k':k,'gain':'linear '+target,'grouping':group_key}

def grouped_rows(rows):
    ordered=sorted(rows,key=lambda r:r['userId']);groups=[]
    for i,r in enumerate(ordered):
        if i==0 or r['userId']!=ordered[i-1]['userId']:groups.append(1)
        else:groups[-1]+=1
    if any(n<2 for n in groups):raise ValueError('Training query has fewer than two rows')
    return ordered,groups

def paired_interval(rows,scores,baseline,target='label'):
    differences=[]
    for uid in sorted({r['userId'] for r in rows}):
        ids=[i for i,r in enumerate(rows) if r['userId']==uid];subset=[rows[i] for i in ids]
        a=metrics(subset,[scores[i] for i in ids],target)['ndcgAtK'];b=metrics(subset,[baseline[i] for i in ids],target)['ndcgAtK']
        if a is not None:differences.append(a-b)
    rng=random.Random(20261018)
    means=sorted(sum(rng.choices(differences,k=len(differences)))/len(differences) for _ in range(2000)) if len(differences)>=5 else []
    return {'users':len(differences),'mean':float(np.mean(differences)) if differences else None,
            'low':means[50] if means else None,'high':means[1950] if means else None,'method':'paired user diagnostic bootstrap; not request-level evidence'}

def peak_rss_mib():
    if os.name!='nt':
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(1048576 if sys.platform=='darwin' else 1024)
    class Counters(ctypes.Structure):
        _fields_=[('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong)]+[(n,ctypes.c_size_t) for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage','PrivateUsage']]
    api=ctypes.windll.psapi.GetProcessMemoryInfo;api.argtypes=[ctypes.c_void_p,ctypes.POINTER(Counters),ctypes.c_ulong]
    handle=ctypes.windll.kernel32.GetCurrentProcess;handle.restype=ctypes.c_void_p
    c=Counters();c.cb=ctypes.sizeof(c)
    if not api(handle(),ctypes.byref(c),c.cb):raise OSError('Memory measurement failed')
    return c.PeakWorkingSetSize/1048576
