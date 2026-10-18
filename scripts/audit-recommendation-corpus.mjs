import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {localDatabase} from './recommendation-local-db.mjs';
import {generateDemo,demoAlgorithm} from '../server/recommendation/demo.mjs';
import {auditCorpus} from './lib/recommendation-corpus-audit.mjs';

if(process.argv.length!==3||process.argv[2]!=='--local'||process.env.NODE_ENV==='production')throw Error('Only --local synthetic, read-only auditing is supported');
const started=performance.now(),db=await localDatabase();
try{
  const data=await db.transaction(async c=>{
    await c.query('SET TRANSACTION READ ONLY');
    const posts=(await c.query('SELECT id,title,body,tags,snapshot,synthetic_batch_id FROM posts WHERE is_synthetic ORDER BY id LIMIT 1001')).rows;
    if(posts.length>1000)throw Error('Synthetic corpus bound exceeded; no truncation allowed');
    const batches=(await c.query('SELECT id,seed,algorithm FROM recommendation_demo_batches WHERE id=ANY($1::uuid[])',[[...new Set(posts.map(p=>p.synthetic_batch_id).filter(Boolean))]])).rows;
    return {posts,batches};
  });
  const contexts=new Map(),routes=JSON.parse(await readFile(new URL('../server/data/classic-citywalks.json',import.meta.url),'utf8'));
  for(const batch of data.batches){
    if(batch.algorithm!==demoAlgorithm)continue;
    const generated=await generateDemo({seed:batch.seed,now:Date.parse('2026-10-17T00:00:00Z')});
    if(generated.batchId!==batch.id)continue;
    const users=new Map(generated.users.map(u=>[u.id,u]));
    for(const p of generated.posts)contexts.set(p.id,{generated:p,keywords:users.get(p.userId).style.keywords});
  }
  const sourceFiles={};
  for(const name of ['server/recommendation/demo.mjs','server/data/classic-citywalks.json','server/social/features.mjs','scripts/lib/recommendation-corpus-audit.mjs']){
    sourceFiles[name]=createHash('sha256').update(await readFile(new URL('../'+name,import.meta.url))).digest('hex');
  }
  const result={...auditCorpus(data.posts,{routes,generatorContexts:contexts}),at:new Date().toISOString(),scope:'local synthetic content',sourceFiles,
    replayScope:'Current generator and route files replay matching persisted posts; historical omitted route tails are not independently archived.',
    elapsedMs:Math.round(performance.now()-started),peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024)};
  const target=new URL('../validation/preference-review/corpus-audit.json',import.meta.url);
  await mkdir(new URL('.',target),{recursive:true});await writeFile(target,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{await db.close();}
