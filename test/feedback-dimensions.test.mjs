/* 验证旅行评价的各体验维度。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {feedbackEvidence,tripFeedbackSchema} from '../server/recommendation/feedback.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installRecommendationRoutes} from '../server/recommendation/routes.mjs';
import {buildProfile,recommendationPreferences,refreshItem} from '../server/recommendation/profiles.mjs';

test('a rushed trip does not imply disliking places, food or a permanent companion',()=>{
  const facts=feedbackEvidence({rating:2,experience:'trip',interests:['园林'],aspects:{places:5,pace:'too_busy',dining:1,stay:1,walking:'too_much'}});
  assert.equal(facts.find(r=>r.origin==='places').sign,1);
  assert.ok(facts.some(r=>r.values['pace.relaxed']===1));assert.ok(facts.some(r=>r.values['mobility.few_walking']===1));
  assert.ok(!facts.some(r=>Object.keys(r.values).some(k=>k.startsWith('food.')||k.startsWith('companion.')||k.startsWith('stay.'))));
  assert.deepEqual(feedbackEvidence({rating:1,experience:'trip',interests:['美食'],aspects:{dining:1}}),[]);
  assert.deepEqual(feedbackEvidence({rating:1,experience:'trip',interests:['园林'],aspects:{}}),[]);
  assert.throws(()=>tripFeedbackSchema.parse({rating:3,aspects:{companion:'parents'}}));
});

test('feedback HTTP separates place labels from pace and reverses profile evidence with owner checks',
 {skip:process.env.TEST_FEEDBACK_DIMENSIONS!=='1',timeout:60000},async()=>{
  const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
  try{
    installRecommendationRoutes(f.app,f);await f.start();const tid=randomUUID(),sid=randomUUID(),pid=randomUUID();
    await f.query('INSERT INTO posts(id,user_id,title,body,tags,snapshot) VALUES($1,$2,$3,$3,$4,$5)',[pid,f.users.other.id,'园林推荐',['园林'],{}]);
    await refreshItem({query:f.query},pid);
    await f.query("INSERT INTO trips(id,user_id,title,request,plan,status) VALUES($1,$2,'评价行程',$3,'{}','completed')",[tid,f.users.user.id,{interests:['园林'],companion:'parents'}]);
    await f.query("INSERT INTO journey_sessions(id,user_id,request) VALUES($1,$2,'{}')",[sid,f.users.user.id]);
    await f.query('INSERT INTO recommendation_trip_sources(session_id,user_id,post_id,trip_id) VALUES($1,$2,$3,$4)',[sid,f.users.user.id,pid,tid]);
    const url='/api/journey/trips/'+tid+'/feedback';
    assert.equal((await f.request(url,{user:'other',method:'PUT',body:{rating:1}})).status,404);
    const body={rating:2,experience:'trip',aspects:{places:5,pace:'too_busy',walking:'too_much',dining:1,stay:1}};
    assert.equal((await f.request(url,{user:'user',method:'PUT',body})).status,200);
    await f.transaction(c=>buildProfile(c,f.users.user.id));
    const p=await recommendationPreferences(f.query,{id:f.users.user.id,preferences:{}});
    assert.ok(p.styleWeights['园林']>0);assert.equal(p.suggestions.pace?.value,'relaxed');
    const outcomes=(await f.query("SELECT kind,active FROM recommendation_outcomes WHERE user_id=$1 AND kind IN ('satisfied','dissatisfied') ORDER BY id",[f.users.user.id])).rows;
    assert.equal(outcomes.findLast(r=>r.kind==='satisfied').active,true);assert.equal(outcomes.findLast(r=>r.kind==='dissatisfied').active,false);
    assert.equal((await f.request(url,{user:'user',method:'PUT',body:{rating:1,experience:'trip',aspects:{dining:1}}})).status,200);
    await f.transaction(c=>buildProfile(c,f.users.user.id));
    assert.equal((await recommendationPreferences(f.query,{id:f.users.user.id,preferences:{}})).suggestions.pace,undefined);
    const last=(await f.query("SELECT DISTINCT ON(kind) kind,active FROM recommendation_outcomes WHERE user_id=$1 AND kind IN ('satisfied','dissatisfied') ORDER BY kind,id DESC",[f.users.user.id])).rows;
    assert.ok(last.every(r=>r.active===false));
    assert.equal((await f.request(url,{user:'user',method:'DELETE'})).status,200);
    assert.equal((await f.request(url,{user:'user'})).data.feedback,null);
  }finally{await f.close();}
});
