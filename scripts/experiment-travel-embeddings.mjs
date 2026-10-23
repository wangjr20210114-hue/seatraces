/* 对比不同嵌入模型的旅行语义排序效果。 */

import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {pipeline,env} from '@huggingface/transformers';
import {digest,normalize} from './lib/offline-semantic.mjs';
import {evaluateExperiment,pairedInterval} from './lib/tower-experiment.mjs';

export const specs={
  'bge-base':{repository:'Xenova/bge-base-zh-v1.5',revision:'71e50dc531959f9e04ebf190ea25b00261a0a186',dimensions:768,pooling:'cls',queryPrefix:'为这个句子生成表示以用于检索相关文章：',passagePrefix:''},
  'e5-small':{repository:'Xenova/multilingual-e5-small',revision:'761b726dd34fb83930e26aab4e9ac3899aa1fa78',dimensions:384,pooling:'mean',queryPrefix:'query: ',passagePrefix:'passage: '},
};
export function formatText(text,query,spec){
  const plain=query?text.replace(/^为这个句子生成表示以用于检索相关文章：/,''):text;
  return (query?spec.queryPrefix:spec.passagePrefix)+plain;
}
export function historyVector(row,posts,profiles){
  const initial=profiles[row.profile];
  if(!row.history.length)return initial;
  if(row.historyWindowEnds.some(end=>end>=row.at))throw Error('Future feedback in history');
  const sum=Array(initial.length).fill(0);
  for(let h=0;h<row.history.length;h++){
    const age=row.at-(row.historyWindowEnds[h]-7*86400000),w=2**(-age/(7*86400000));
    for(let j=0;j<sum.length;j++)sum[j]+=posts[row.history[h]][j]*w;
  }
  const past=normalize(sum);
  return normalize(initial.map((v,j)=>.6*v+.4*past[j]));
}
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
export const cosine=(a,b)=>dot(normalize(a),normalize(b));

async function main(){
  const [flag,alias,...extra]=process.argv.slice(2),spec=specs[alias];
  if(flag!=='--local'||!spec||extra.length||process.env.NODE_ENV==='production')throw Error('Use --local bge-base|e5-small only');
  const root=new URL('../validation/travel-models/',import.meta.url),target=new URL(alias+'-report.json',root);
  try{await readFile(target);throw Error('Report already exists; preserve evidence');}catch(e){if(e.code!=='ENOENT')throw e;}
  const dataRaw=await readFile(new URL('../validation/unisrec/input.json',import.meta.url),'utf8'),data=JSON.parse(dataRaw);
  const textsRaw=await readFile(new URL('texts.json',root),'utf8'),texts=JSON.parse(textsRaw);
  if(data.activationAllowed!==false||texts.inputSha256!==digest(dataRaw)||texts.posts.some((p,i)=>p.id!==data.posts[i].id)||texts.profiles.length!==data.profiles.length)throw Error('Frozen input mismatch');
  const manifest=JSON.parse(await readFile(new URL('models-manifest.json',root),'utf8'));
  const installed=manifest.models.find(m=>m.alias===alias);
  if(!installed||installed.revision!==spec.revision)throw Error('Pinned model is not installed');
  for(const file of installed.files){
    const raw=await readFile(new URL('models/'+alias+'/'+file.name,root));
    const {createHash}=await import('node:crypto');
    if(raw.length!==file.bytes||createHash('sha256').update(raw).digest('hex')!==file.sha256)throw Error('Installed model checksum mismatch');
  }
  env.allowRemoteModels=false;env.localModelPath=fileURLToPath(new URL('models/',root));
  const started=performance.now(),loaded=performance.now();
  const encoder=await pipeline('feature-extraction',alias,{local_files_only:true,dtype:'q8',device:'cpu',session_options:{intraOpNumThreads:2,interOpNumThreads:1}});
  const loadMs=performance.now()-loaded,cache=new URL('vectors-'+alias+'/',root);await mkdir(cache,{recursive:true});
  const fixed={...spec,dtype:'q8',normalize:true,maxTokens:256,batch:1,historyMix:[.6,.4],modes:['static','history'],activationAllowed:false};
  await writeFile(new URL(alias+'-config.json',root),JSON.stringify(fixed,null,2));
  let hits=0,computed=0;const timings=[],all=[...texts.posts.map(p=>formatText(p.text,false,spec)),...texts.profiles.map(p=>formatText(p.text,true,spec))],vectors=[];
  try{
    for(let i=0;i<all.length;i++){
      const text=all[i],key=digest({fixed,text}),file=new URL(key+'.json',cache);let vector;
      try{const old=JSON.parse(await readFile(file,'utf8'));if(old.key!==key)throw Error('Cache identity mismatch');vector=old.vector;hits++;}
      catch(e){if(e.code!=='ENOENT')throw e;
        const t=performance.now();vector=(await encoder(text,{pooling:spec.pooling,normalize:true,truncation:true,max_length:256})).tolist()[0];
        timings.push(performance.now()-t);computed++;
        await writeFile(file,JSON.stringify({key,vector}),{flag:'wx'});
      }
      if(vector.length!==spec.dimensions||!vector.every(Number.isFinite)||Math.abs(Math.hypot(...vector)-1)>.002)throw Error('Invalid embedding');
      vectors.push(vector);
      if(process.resourceUsage().maxRSS>1.5*1024*1024)throw Error('Offline RSS budget 1.5 GiB exceeded');
      if((i+1)%50===0)console.log(JSON.stringify({model:alias,encoded:i+1,total:all.length,peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024)}));
    }
    const posts=vectors.slice(0,texts.posts.length),profiles=vectors.slice(texts.posts.length),scores={static:new Map(),history:new Map(),baseline:new Map()};
    const t=performance.now();
    for(const row of data.rows){
      scores.static.set(row,dot(profiles[row.profile],posts[row.post]));
      scores.history.set(row,dot(historyVector(row,posts,profiles),posts[row.post]));
      scores.baseline.set(row,cosine(data.profiles[row.profile].features.slice(0,96),data.posts[row.post].features.slice(0,96)));
    }
    const scoringMs=performance.now()-t,report={status:'completed',scope:'local synthetic',activationAllowed:false,spec:fixed,inputSha256:digest(dataRaw),textsSha256:digest(textsRaw),sourceSha256:digest(await readFile(fileURLToPath(import.meta.url),'utf8')),loadMs,cacheHits:hits,encoded:computed,scoringMs,rows:data.rows.length,partitions:{},modelBytes:installed.files.reduce((n,f)=>n+f.bytes,0)};
    for(const name of ['validation','test']){
      const rows=data.rows.filter(r=>r.partition===name),base=r=>scores.baseline.get(r);
      report.partitions[name]={rows:rows.length,baseline:evaluateExperiment(rows,base)};
      for(const mode of fixed.modes){
        const score=r=>scores[mode].get(r);
        report.partitions[name][mode]={metrics:evaluateExperiment(rows,score),interval:pairedInterval(rows,score,base),strata:{}};
        for(const history of [false,true]){
          const subset=rows.filter(r=>!!r.history.length===history);
          report.partitions[name][mode].strata[history?'withHistory':'noHistory']={rows:subset.length,metrics:subset.length?evaluateExperiment(subset,score):null};
        }
      }
    }
    timings.sort((a,b)=>a-b);
    report.timing={perTextP50Ms:timings[Math.floor(timings.length*.5)]??null,perTextP95Ms:timings[Math.min(timings.length-1,Math.floor(timings.length*.95))]??null,scope:'single text encoding on local CPU, excludes HTTP; scoring uses cached vectors'};
    report.elapsedSeconds=(performance.now()-started)/1000;report.peakRssMiB=process.resourceUsage().maxRSS/1024;
    report.limitation='Pretrained semantic similarity is not trained user preference. Historical synthetic, user-pooled ranking, not independent online evidence. Neither mode is selected using test results.';
    await writeFile(target,JSON.stringify(report,null,2),{flag:'wx'});
    console.log(JSON.stringify({model:alias,status:report.status,validation:report.partitions.validation,test:report.partitions.test,elapsedSeconds:report.elapsedSeconds,peakRssMiB:report.peakRssMiB}));
  }finally{await encoder.dispose();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
