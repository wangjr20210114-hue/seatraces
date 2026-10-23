/* 检查用户行为对兴趣画像和后续推荐的影响。 */

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {iterationFixture} from '../test/helpers/iteration-db.mjs';
import {installCommunityInteractions} from '../server/services/community-interactions.mjs';
import {installSocialCommunity} from '../server/social/community.mjs';
import {recordExposure,updateExposure} from '../server/recommendation/events.mjs';
import {refreshItem,buildProfile,readProfile,recommendationPreferences} from '../server/recommendation/profiles.mjs';
import {recommend} from '../server/recommendation/engine.mjs';
import {createStyleWorker} from '../server/social/style-store.mjs';
import {personalizedQuestions} from '../server/services/questions.mjs';

if(!process.argv.includes('--local')||process.env.NODE_ENV==='production'||process.env.ITERATION_DB_CONFIG)throw Error('Only the default isolated local fixture is allowed');
const report={protocol:'personalization-functional/1',startedAt:new Date().toISOString(),
  environment:'isolated local PostgreSQL; simulated content and actions; no production access',
  externalCalls:0,training:false,scenarios:[],limitations:[
    'Topic concentration tests mechanism, not the probability a real person likes a post.',
    'Questions call the actual service function with model disabled; this is not full questionnaire HTTP/UI acceptance.',
    'Impression creation time is shifted only in the disposable fixture to simulate reading without a wall-clock wait.',
    'Worker tick is driven explicitly; the default production scheduler runs every 3 seconds and processes one user per tick.',
  ]};
let f;const started=performance.now(),timings=[];
try{
  f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
  installCommunityInteractions(f.app,f);
  installSocialCommunity(f.app,{...f,recommend:(u,o)=>recommend(f.query,u,o),onImpression:recordExposure,onVisible:updateExposure});
  await f.start();
  const themes=['园林','艺术','夜景'],posts=[],authors=Array.from({length:6},()=>randomUUID());
  for(const [i,id] of authors.entries())await f.query("INSERT INTO users(id,username,nickname,password_hash) VALUES($1,$2,$2,'!disabled')",[id,'functional_author_'+i]);
  for(let n=0;n<120;n++){
    const topic=themes[n%3],id='00000000-0000-4000-8000-'+String(n+1).padStart(12,'0');
    await f.query("INSERT INTO posts(id,user_id,title,body,tags,snapshot,created_at) VALUES($1,$2,$3,$4,$5,'{}','2026-10-10T00:00:00Z')",
      [id,authors[Math.floor(n/3)%authors.length],topic+'内容'+n,topic+'内容用于隔离功能验收。', [topic]]);
    posts.push({id,topic});await refreshItem({query:f.query},id);
  }
  const topicById=new Map(posts.map(p=>[p.id,p.topic]));
  const selected=Object.fromEntries(themes.map(t=>[t,posts.filter(p=>p.topic===t).slice(0,6).map(p=>p.id)]));
  const exclude=Object.values(selected).flat();
  const errors=[],worker=createStyleWorker({...f,afterRebuild:buildProfile,onError:e=>errors.push(e.message)});
  async function drain(){for(let i=0;i<20;i++){if(!(await f.query('SELECT 1 FROM style_dirty_users LIMIT 1')).rowCount)break;await worker.tick();}
    assert.deepEqual(errors,[]);assert.equal((await f.query('SELECT 1 FROM style_dirty_users LIMIT 1')).rowCount,0);}
  async function request(path,options){const t=performance.now(),r=await f.request(path,options);timings.push(performance.now()-t);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
  async function snapshot(topic){
    const counts=[],requests=[];
    for(let i=0;i<5;i++){
      const feed=await request('/api/social/feed',{user:'user',body:{limit:10,exclude}});
      assert.equal(feed.items.length,10);assert.ok(feed.items.every(p=>!exclude.includes(p.id)));
      const trace=(await f.query('SELECT trace FROM recommendation_requests WHERE id=$1',[feed.requestId])).rows[0].trace;
      assert.equal(trace.models.tower,null);assert.equal(trace.models.ranker,null);
      counts.push(feed.items.filter(p=>topicById.get(p.id)===topic).length);requests.push(feed.requestId);
    }
    const user={id:f.users.user.id,preferences:{}},p=await readProfile(f.query,user),pref=await recommendationPreferences(f.query,user);
    const q=await personalizedQuestions(pref,{enabled:false}),interest=q.questions.find(q=>q.id==='interests');
    return {matchingOf10:counts,meanMatchingOf10:counts.reduce((a,b)=>a+b,0)/counts.length,requestIds:requests,
      profileVersion:p.version,contentDimensions:Object.keys(p.content).length,travelDimensions:Object.keys(p.travel).length,
      topicTravelWeight:pref.styleWeights[topic]??null,questionIds:q.questions.map(x=>x.id),interestTitle:interest.title,firstInterest:interest.options[0]};
  }
  for(const topic of themes){
    await f.query('DELETE FROM reactions WHERE user_id=$1',[f.users.user.id]);
    await f.query('DELETE FROM browse_events WHERE user_id=$1',[f.users.user.id]);
    await f.query('DELETE FROM social_feedback WHERE user_id=$1',[f.users.user.id]);
    await drain();
    const result={topic,actionsPerStage:6};report.scenarios.push(result);
    result.before=await snapshot(topic);
    const frozen=await request('/api/social/feed?limit=10',{user:'user'});
    const sessionId=frozen.nextCursor.split(':')[0];
    const fixedIds=(await f.query('SELECT post_ids FROM social_feed_sessions WHERE id=$1',[sessionId])).rows[0].post_ids;
    for(const id of selected[topic]){
      const imp=randomUUID();await request('/api/social/posts/'+id+'/impressions',{user:'user',body:{id:imp,context:'detail'}});
      await f.query("UPDATE social_impressions SET created_at=now()-interval '61 seconds' WHERE id=$1",[imp]);
      await request('/api/social/impressions/'+imp,{user:'user',method:'PUT',body:{visibleMs:60000}});
    }
    await drain();
    const page=await request('/api/social/feed?limit=10&cursor='+encodeURIComponent(frozen.nextCursor),{user:'user'});
    assert.deepEqual(page.items.map(p=>p.id),fixedIds.slice(10,20));result.existingPoolFrozen=true;
    result.browse=await snapshot(topic);
    assert.ok(result.browse.contentDimensions>0);assert.equal(result.browse.travelDimensions,0);
    assert.equal(result.browse.interestTitle,result.before.interestTitle);
    for(const id of selected[topic])await request('/api/posts/'+id+'/reactions',{user:'user',body:{kind:'like',active:true}});
    await drain();result.like=await snapshot(topic);
    for(const id of selected[topic])await request('/api/posts/'+id+'/reactions',{user:'user',body:{kind:'save',active:true}});
    await drain();result.save=await snapshot(topic);
    assert.ok(result.like.travelDimensions>0);assert.ok(result.save.topicTravelWeight>result.like.topicTravelWeight);
    assert.match(result.save.interestTitle,new RegExp(topic));assert.equal(result.save.firstInterest,topic);
    assert.deepEqual(result.save.questionIds,result.before.questionIds);
    for(const id of selected[topic])await request('/api/social/posts/'+id+'/feedback',{user:'user',method:'PUT',body:{notInterested:true}});
    await drain();result.negative=await snapshot(topic);
    assert.ok(result.negative.topicTravelWeight<0);
    for(const id of selected[topic]){
      await request('/api/social/posts/'+id+'/feedback',{user:'user',method:'PUT',body:{notInterested:false}});
      for(const kind of ['like','save'])await request('/api/posts/'+id+'/reactions',{user:'user',body:{kind,active:false}});
    }
    await drain();result.undo=await snapshot(topic);assert.equal(result.undo.travelDimensions,0);
    assert.equal(result.undo.interestTitle,result.before.interestTitle);
    const control=await readProfile(f.query,{id:f.users.other.id,preferences:{}});
    assert.equal(Object.keys(control.travel).length,0);assert.equal(Object.keys(control.content).length,0);
    result.otherUserUnchanged=true;
    result.sameTopicIncrease=result.save.meanMatchingOf10>result.before.meanMatchingOf10;
    assert.ok(result.browse.meanMatchingOf10>result.before.meanMatchingOf10,'new batches should reflect repeated reading');
    assert.ok(result.sameTopicIncrease,'saved themes should rise among unseen candidates');
    assert.ok(result.negative.meanMatchingOf10<result.save.meanMatchingOf10,'negative feedback should reduce related candidates');
    console.log(JSON.stringify({topic,before:result.before.meanMatchingOf10,browse:result.browse.meanMatchingOf10,like:result.like.meanMatchingOf10,save:result.save.meanMatchingOf10,negative:result.negative.meanMatchingOf10,questions:result.save.interestTitle}));
  }
  report.status='completed';report.runtimeBusinessChanges=false;report.questionStructureIsAdaptive=false;
}catch(e){report.status='failed';report.error=e.stack;process.exitCode=1;}
finally{
  if(f){await f.close();report.isolatedSchemaRemoved=true;}
  timings.sort((a,b)=>a-b);report.performance={elapsedMs:Math.round(performance.now()-started),httpCalls:timings.length,
    httpP95Ms:Math.round(timings[Math.floor(timings.length*.95)]||0),peakProcessRssMiB:Math.round(process.resourceUsage().maxRSS/1024),
    scope:'single local process including fixture; not production capacity'};
  await mkdir('validation/personalization-functional',{recursive:true});
  const path='validation/personalization-functional/behavior-'+Date.now()+'.json';await writeFile(path,JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,report:path,performance:report.performance,error:report.error}));
}
