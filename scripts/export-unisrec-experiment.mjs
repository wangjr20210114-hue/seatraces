import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {localDatabase} from './recommendation-local-db.mjs';
import {trainingSamples} from '../server/recommendation/training.mjs';
import {partitionSamples,evaluateExperiment} from './lib/tower-experiment.mjs';
import {cosine} from '../server/recommendation/features.mjs';
import {cachedEmbedding,postText,profileText,semanticSpec,digest} from './lib/offline-semantic.mjs';
import {sequenceInputs} from './lib/unisrec-data.mjs';

if(process.argv.length!==3||process.argv[2]!=='--local'||process.env.NODE_ENV==='production') throw Error('Only --local is allowed; no production or activation');
const root=new URL('../validation/unisrec/',import.meta.url),started=performance.now(),db=await localDatabase();
try {
  const {samples,posts}=await db.transaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const samples=await trainingSamples(c.query.bind(c),'synthetic');
    if(samples.length>5000)throw Error('At most 5000 samples; no silent truncation');
    const ids=[...new Set(samples.map(r=>r.postId))];
    const posts=(await c.query('SELECT id,title,body,tags,revision,created_at,updated_at FROM posts WHERE is_synthetic AND id=ANY($1::uuid[]) ORDER BY id',[ids])).rows;
    return {samples,posts};
  });
  const split=partitionSamples(samples),byPost=new Map(posts.map(p=>[p.id,p]));
  for(const row of samples){
    const p=byPost.get(row.postId);
    if(!p||p.revision!==1||new Date(p.created_at).getTime()>row.at||new Date(p.updated_at).getTime()>row.at)throw Error('Historical text provenance unavailable');
  }
  const cache=fileURLToPath(new URL('../validation/tower-semantic/cache/',import.meta.url));
  const cached=async text=>(await cachedEmbedding(cache,text,async()=>{throw Error('Missing existing BGE cache; no implicit model calls');})).vector;
  const items=new Map(),queries=new Map();
  for(const p of posts)items.set(p.id,await cached(postText(p)));
  for(const row of samples){const text=profileText(row.user);if(!queries.has(text))queries.set(text,await cached(text));}
  const result={version:'offline-unisrec-input/1',scope:'local synthetic',activationAllowed:false,datasetDigest:digest(samples),
    semanticSpec,corpusDigest:digest(posts.map(p=>[p.id,p.revision,postText(p)])),
    cutoff:split.cutoff,testStarts:split.testStarts,
    historyPolicy:'Positive feedback only after its full seven-day observation window; previous 30 days; last 20 items; explicit preference appended as final token.',
    evaluationLimit:'Previously inspected synthetic, user-pooled holdout; not independent real-user evidence.',
    baselineValidation:evaluateExperiment(split.validation,s=>cosine(s.user,s.item)),
    ...sequenceInputs(samples,items,queries,split)};
  await mkdir(root,{recursive:true});
  const target=new URL('input.json',root),serialized=JSON.stringify(result);
  try{const existing=await readFile(target,'utf8');if(existing!==serialized)throw Error('Frozen experiment input differs; preserve prior run');}
  catch(error){if(error.code!=='ENOENT')throw error;await writeFile(target,serialized,{flag:'wx'});}
  console.log(JSON.stringify({rows:result.rows.length,posts:result.posts.length,profiles:result.profiles.length,
    historyRows:result.rows.filter(r=>r.history.length).length,maxHistory:Math.max(...result.rows.map(r=>r.history.length)),
    partitions:Object.fromEntries(['train','validation','test','embargo'].map(k=>[k,result.rows.filter(r=>r.partition===k).length])),
    baselineValidation:result.baselineValidation,datasetDigest:result.datasetDigest,inputBytes:Buffer.byteLength(serialized),
    elapsedMs:Math.round(performance.now()-started),peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024),databaseWrites:0,modelCalls:0,activationAllowed:false}));
}finally{await db.close();}
