// Read-only local synthetic corpus; preserve exact identities of the frozen run.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {localDatabase} from './recommendation-local-db.mjs';
import {trainingSamples} from '../server/recommendation/training.mjs';
import {cachedEmbedding,postText,profileText,combine,digest} from './lib/offline-semantic.mjs';
if(process.argv.slice(2).join(' ')!=='--local'||process.env.NODE_ENV==='production')throw Error('Only --local is allowed');
const root=new URL('../validation/travel-models/',import.meta.url);
const raw=await readFile(new URL('../validation/unisrec/input.json',import.meta.url),'utf8'),input=JSON.parse(raw),db=await localDatabase();
try{
  const {samples,posts}=await db.transaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return {samples:await trainingSamples(c.query.bind(c),'synthetic'),posts:(await c.query('SELECT id,title,body,tags,revision,created_at,updated_at FROM posts WHERE is_synthetic AND id=ANY($1::uuid[]) ORDER BY id',[input.posts.map(p=>p.id)])).rows};
  });
  if(digest(samples)!==input.datasetDigest||digest(posts.map(p=>[p.id,p.revision,postText(p)]))!==input.corpusDigest)throw Error('Frozen corpus changed; do not mix experiments');
  const byId=new Map(posts.map(p=>[p.id,p]));
  for(const row of samples){const p=byId.get(row.postId);if(!p||p.revision!==1||+new Date(p.created_at)>row.at||+new Date(p.updated_at)>row.at)throw Error('Historical text provenance missing');}
  const profileMap=new Map(),cache=fileURLToPath(new URL('../validation/tower-semantic/cache/',import.meta.url));
  for(const row of samples){
    const text=profileText(row.user);if([...profileMap.values()].includes(text))continue;
    const {vector}=await cachedEmbedding(cache,text,async()=>{throw Error('Existing BGE cache missing');});
    profileMap.set(digest(combine(row.user,vector)),text);
  }
  const result={version:'travel-model-texts/1',activationAllowed:false,inputSha256:digest(raw),corpusDigest:input.corpusDigest,
    posts:input.posts.map(p=>({id:p.id,text:postText(byId.get(p.id))})),profiles:input.profiles.map(p=>({text:profileMap.get(digest(p.features))}))};
  if(result.profiles.some(p=>!p.text))throw Error('Unmatched frozen profile');
  await mkdir(root,{recursive:true});const out=JSON.stringify(result),path=new URL('texts.json',root);
  try{if(await readFile(path,'utf8')!==out)throw Error('Existing text export differs');}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(path,out,{flag:'wx'});}
  console.log(JSON.stringify({posts:result.posts.length,profiles:result.profiles.length,bytes:Buffer.byteLength(out),databaseWrites:0,activationAllowed:false}));
}finally{await db.close();}
