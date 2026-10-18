import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { localDatabase } from './recommendation-local-db.mjs';
import { cosine } from '../server/recommendation/features.mjs';
import { mlpScore } from './lib/offline-mlp.mjs';
import { cachedEmbedding, profileText, postText, normalize } from './lib/offline-semantic.mjs';
import { hash, disagreement, renderReview } from './lib/preference-review.mjs';
if (process.argv.length !== 3 || process.argv[2] !== '--local' || process.env.NODE_ENV === 'production') throw Error('Only --local is supported; no production or activation');
const root = new URL('../validation/preference-review/', import.meta.url);
await mkdir(root, {recursive:true});
try { await readFile(new URL('protocol-private.json', root)); throw Error('Study already frozen; do not overwrite collected evidence'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const db = await localDatabase();
try {
  const profiles = (await db.query("SELECT DISTINCT r.user_vector FROM recommendation_requests r JOIN users u ON u.id=r.user_id WHERE u.is_synthetic AND r.context->>'synthetic'='true' LIMIT 21")).rows.map(r => r.user_vector).sort((a,b) => profileText(a).localeCompare(profileText(b),'zh'));
  if (!profiles.length || profiles.length > 20) throw Error('Unexpected local synthetic profile population');
  const selected = JSON.parse(await readFile(new URL('../validation/tower-semantic/selected.json', import.meta.url)));
  if (selected.config.name !== 'structured-mlp32' || selected.model.input !== 96 || selected.activation !== false) throw Error('Review candidate must be the frozen, validation-selected offline model');
  const posts = (await db.query('SELECT p.id,p.title,p.body,p.tags,p.snapshot,p.revision,i.vector FROM posts p JOIN recommendation_items i ON i.post_id=p.id WHERE p.is_synthetic AND p.hidden_at IS NULL AND p.revision=i.revision ORDER BY p.id LIMIT 1001')).rows;
  if (posts.length > 1000) throw Error('Review corpus bound exceeded');
  const cache = fileURLToPath(new URL('../validation/tower-semantic/cache/', import.meta.url)), vectors = new Map();
  const cached = async text => (await cachedEmbedding(cache, text, async () => { throw Error('Missing approved offline semantic cache; review never creates new model calls'); })).vector;
  // Match the exact already-encoded corpus; unused original posts have no cache.
  for (const p of posts) { try { vectors.set(p.id, await cached(postText(p))); } catch (e) { if (!e.message.startsWith('Missing approved')) throw e; } }
  const corpus = posts.filter(p => vectors.has(p.id)), byId = new Map(corpus.map(p => [p.id,p]));
  const tasks = [], probes = [], used = new Set(), agreementOnly = [];
  for (const user of profiles) {
    const text = profileText(user), semantic = await cached(text);
    const scores = { rule: p => cosine(user,p.vector), tower: p => mlpScore(selected.model,normalize(user),normalize(p.vector)), semantic: p => cosine(semantic,vectors.get(p.id)) };
    const rankings = Object.fromEntries(Object.entries(scores).map(([name,score]) => [name,corpus.map(p => ({id:p.id,score:score(p)})).sort((a,b) => b.score-a.score || a.id.localeCompare(b.id))]));
    for (const competitor of ['tower','semantic']) {
      const pair = disagreement(rankings.rule,rankings[competitor],used);
      if (!pair) { agreementOnly.push({profile:hash(user),competitor}); continue; }
      used.add(pair.pair);
      const id = 'q'+String(tasks.length+1).padStart(2,'0'), options = pair.ids.map(postId => {
        const p = byId.get(postId), stops = (p.snapshot?.days || []).flatMap(d => d.stops || []).map(s => s.name).filter(Boolean);
        return {key:hash('blind-review-v1:'+postId).slice(0,20),title:p.title,body:p.body,tags:p.tags || [],route:stops.length ? '路线：'+stops.join(' → ') : ''};
      });
      tasks.push({id,scenario:text.replace('为这个句子生成表示以用于检索相关文章：',''),options});
      probes.push({taskId:id,profile:hash(user),methods:['rule',competitor],postIds:pair.ids,preferredKeys:options.map(o => o.key)});
    }
  }
  if (tasks.length < 10) throw Error('Too few distinct disagreements for the proposed review');
  const primaryCount=tasks.length;
  for (let i=0;i<Math.min(4,primaryCount);i++) { const original=tasks[Math.floor(i*primaryCount/4)], id='q'+String(tasks.length+1).padStart(2,'0'); tasks.push({...original,id,options:[...original.options].reverse()}); probes.push({taskId:id,repeatOf:original.id}); }
  const study={version:'seatraces-blind-preference/1',primaryCount,tasks}; study.protocolId=hash(study);
  const protocol={protocolId:study.protocolId,createdAt:new Date().toISOString(),scope:'Existing local synthetic content; no real-user exports',selection:'First reciprocal rank disagreement within each method top 30; deterministic; no human labels consulted',candidate:hash(selected.model),corpus:hash(corpus.map(p=>[p.id,p.revision,postText(p)])),agreementOnly,probes,activationAllowed:false};
  await writeFile(new URL('study.json',root),JSON.stringify(study)); await writeFile(new URL('protocol-private.json',root),JSON.stringify(protocol,null,2));
  const client=await readFile(new URL('lib/preference-review-client.js',import.meta.url),'utf8');
  await writeFile(new URL('SeaTraces-推荐盲评.html',root),renderReview(study,client));
  console.log(JSON.stringify({protocolId:study.protocolId,primaryQuestions:primaryCount,repeatQuestions:tasks.length-primaryCount,encodedPosts:corpus.length,profiles:profiles.length,modelCalls:0,databaseWrites:0,activation:false}));
} finally { await db.close(); }
