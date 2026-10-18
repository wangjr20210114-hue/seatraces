// Read-only local export; keep real request identities even when unusable for LTR.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {localDatabase} from './recommendation-local-db.mjs';
import {digest,postText} from './lib/offline-semantic.mjs';
if(process.argv.slice(2).join(' ')!=='--local'||process.env.NODE_ENV==='production')throw Error('Only --local');
const root=new URL('../validation/ranking-diagnostic/',import.meta.url);
const raw=await readFile(new URL('../validation/unisrec/input.json',import.meta.url),'utf8'),frozen=JSON.parse(raw);
if(frozen.scope!=='local synthetic'||frozen.activationAllowed!==false||frozen.rows.length>5000)throw Error('Invalid frozen source');
const db=await localDatabase();
try {
 const source=await db.transaction(async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const rows=(await c.query(`SELECT e.id,e.request_id,e.user_id,e.post_id,e.position,e.visible_ms,e.created_at,
   r.created_at AS requested_at,cardinality(r.candidate_ids) AS candidate_count,r.user_vector,e.item_vector,
   (SELECT item->'parts' FROM jsonb_array_elements(r.trace->'items') item WHERE item->>'id'=e.post_id::text LIMIT 1) parts,
   (SELECT jsonb_agg(jsonb_build_object('kind',s.kind,'active',s.active,'at',s.occurred_at)) FROM
    (SELECT DISTINCT ON(o.kind) o.kind,o.active,o.occurred_at FROM recommendation_outcomes o
     WHERE o.user_id=e.user_id AND (o.post_id=e.post_id OR (o.kind='follow' AND o.author_id=p.user_id))
      AND o.occurred_at>=e.created_at AND o.occurred_at<e.created_at+interval '7 days'
     ORDER BY o.kind,o.occurred_at DESC,o.id DESC) s) outcomes
   FROM recommendation_exposures e JOIN recommendation_requests r ON r.id=e.request_id
   JOIN users u ON u.id=e.user_id JOIN posts p ON p.id=e.post_id
   WHERE u.is_synthetic AND p.is_synthetic AND r.context->>'synthetic'='true'
    AND e.visible_ms>=1000 AND e.created_at<now()-interval '7 days'
   ORDER BY e.created_at,e.id LIMIT 20001`)).rows;
  if(rows.length>20000)throw Error('Diagnostic source bound exceeded');
  const posts=(await c.query('SELECT id,title,body,tags,snapshot,revision,created_at,updated_at FROM posts WHERE is_synthetic AND id=ANY($1::uuid[]) ORDER BY id',[frozen.posts.map(p=>p.id)])).rows;
  return {rows,posts};
 });
 const byPair=new Map(source.rows.map(r=>[[r.user_id,r.post_id,new Date(r.created_at).getTime()].join(':'),r]));
 const rows=frozen.rows.map(row=>{
  const found=byPair.get([row.userId,row.postId,row.at].join(':'));
  if(!found||!found.parts||new Date(found.requested_at).getTime()>row.at)throw Error('Missing historical exposure');
  const active=new Set((found.outcomes||[]).filter(o=>o.active).map(o=>o.kind));
  const value=active.has('not_interested')||active.has('dissatisfied')?-4:active.has('satisfied')?5:active.has('adopt')?4:active.has('save')?3:active.has('recommend')?2:active.has('like')?1:active.has('follow')?.6:active.has('comment')?.5:0;
  if((value>0?1:0)!==row.label||(value?Math.abs(value):.2)!==row.weight)throw Error('Frozen outcome labels changed');
  // Grading is a diagnostic secondary target; it does not replace the old gate.
  const grade=value>0?(active.has('satisfied')?4:active.has('adopt')?3:active.has('save')||active.has('recommend')?2:1):0;
  return {...row,requestId:found.request_id,exposureId:found.id,position:found.position,visibleMs:found.visible_ms,
   candidateCount:found.candidate_count,parts:found.parts,grade,outcomes:found.outcomes||[],userVector:found.user_vector,itemVector:found.item_vector};
 });
 const posts=source.posts.map(p=>{
  const times=rows.filter(r=>r.postId===p.id).map(r=>r.at);
  if(p.revision!==1||new Date(p.created_at).getTime()>Math.min(...times)||new Date(p.updated_at).getTime()>Math.min(...times))throw Error('Historical text unavailable');
  return {...p,text:postText(p)};
 });
 const counts=new Map();for(const row of rows)counts.set(row.requestId,(counts.get(row.requestId)||0)+1);
 const output={version:'offline-ranking-diagnostic/1',scope:'local synthetic',activationAllowed:false,
  inputSha256:digest(raw),datasetDigest:frozen.datasetDigest,rows,posts,
  requestAudit:{requests:counts.size,multipleExposures:[...counts.values()].filter(n=>n>1).length,maxExposures:Math.max(...counts.values())},
  labelPolicy:'Original binary/weight unchanged. Secondary grade: explicit negative or no positive=0; like/comment/follow=1; save/recommend=2; adopt=3; satisfied=4. Negative overrides. No summed duplicate actions.',
  limitation:'User-pooled diagnostic only; singleton requests cannot evaluate per-request ranking. No propensity recorded; no IPS claim.'};
 await mkdir(root,{recursive:true});const target=new URL('input.json',root),content=JSON.stringify(output);
 try{if(await readFile(target,'utf8')!==content)throw Error('Preserve existing frozen export');}
 catch(e){if(e.code!=='ENOENT')throw e;await writeFile(target,content,{flag:'wx'});}
 console.log(JSON.stringify({rows:rows.length,posts:posts.length,...output.requestAudit,sha256:digest(content),databaseWrites:0,modelCalls:0}));
}finally{await db.close();}
