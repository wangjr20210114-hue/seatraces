import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installCommunityInteractions} from '../server/services/community-interactions.mjs';
import {refreshItem,buildProfile,readProfile,recommendationPreferences} from '../server/recommendation/profiles.mjs';
import {createStyleWorker} from '../server/social/style-store.mjs';
import {personalizedQuestions} from '../server/services/questions.mjs';
import {clusterScenicPlaces} from '../server/domain/scenic-clusters.mjs';
import {createJourneyDraft} from '../server/services/journey-draft.mjs';

// This verifies real HTTP interaction -> PostgreSQL -> profile worker ->
// questionnaire/candidate order/model input/final draft. The external LLM and
// opening-hours provider are deterministic substitutes, not live acceptance.
test('PERS-LOOP-01 saves personalize the next questions and draft; explicit choices win and undo restores baseline',
  {skip:process.env.TEST_RECOMMENDATION!=='1',timeout:60000},async t=>{
  const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
  try{
    installCommunityInteractions(f.app,f);await f.start();
    const reader={id:f.users.user.id,preferences:{}},other={id:f.users.other.id,preferences:{}},ids=[];
    for(const title of ['园林漫步：回廊与池塘','园林游记：亭台与花窗']){
      const id=randomUUID();ids.push(id);
      await f.query('INSERT INTO posts(id,user_id,title,body,tags,snapshot) VALUES($1,$2,$3,$3,$4,$5)',[id,other.id,title,['园林'],{}]);
      await refreshItem({query:f.query},id);
    }
    const city={id:'city',name:'验收城',lat:31,lng:121,timezone:'Asia/Shanghai'};
    const museum={id:'a-museum',name:'城市博物馆',category:'attraction',lat:31,lng:121,traits:{tourism:'museum'}};
    const garden={id:'z-garden',name:'花窗园林',category:'leisure',lat:31.001,lng:121,traits:{leisure:'garden'}};
    const places=[museum,garden],request={origin:{label:city.name},start:'2027-06-20',end:'2027-06-20'};
    const errors=[],worker=createStyleWorker({...f,afterRebuild:buildProfile,onError:e=>errors.push(e)});
    async function drainProfiles(){
      for(let attempt=0;attempt<10;attempt++){
        if(!(await f.query('SELECT 1 FROM style_dirty_users LIMIT 1')).rowCount)break;
        await worker.tick();assert.deepEqual(errors,[]);
      }
      assert.equal((await f.query('SELECT 1 FROM style_dirty_users LIMIT 1')).rowCount,0,'profile queue must finish before checking the next request');
    }
    const preferences=()=>recommendationPreferences(f.query,reader);
    const interestQuestion=async pref=>(await personalizedQuestions(pref,{enabled:false})).questions.find(q=>q.id==='interests');
    const list=pref=>clusterScenicPlaces(places,pref).flatMap(c=>c.members).map(p=>p.id);
    async function draft(pref,{points=places,choose,closedId}={}){
      let captured;
      const fn=createJourneyDraft({model:async(_prompt,input)=>{
        captured=structuredClone(input);
        return {days:input.dates.map(date=>({date,places:[choose?choose(input):input.candidates[0].ref]}))};
      },opening:async p=>p.id===closedId?{dayState:'closed',status:'parsed'}:null});
      const result=await fn(request,[city],{[city.id]:points},pref);
      return {result,captured};
    }
    const initial=await preferences(),initialQuestion=await interestQuestion(initial),initialList=list(initial);
    const before=await draft(initial);
    assert.equal(before.result.days[0].stops[0].id,museum.id);
    assert.notEqual(initialQuestion.options[0],'园林');
    await f.query('DELETE FROM style_dirty_users');

    await t.test('real save actions propagate through the profile worker into questions, candidates and model inputs',async()=>{
      for(const id of ids)assert.equal((await f.request('/api/posts/'+id+'/reactions',{user:'user',body:{kind:'save',active:true}})).status,200);
      await drainProfiles();
      const learned=await preferences(),question=await interestQuestion(learned),planned=await draft(learned);
      assert.ok(learned.styleWeights['园林']>=.3);
      assert.equal(question.options[0],'园林');assert.match(question.title,/园林/);
      assert.deepEqual([...question.options].sort(),[...initialQuestion.options].sort());
      assert.deepEqual(list(learned),[garden.id,museum.id]);
      assert.equal(planned.captured.candidates[0].name,garden.name);
      assert.equal(planned.captured.preferences.styleWeights['园林'],learned.styleWeights['园林']);
      assert.equal(planned.result.days[0].stops[0].id,garden.id);
      assert.equal(Object.keys((await readProfile(f.query,other)).travel).length,0);
    });

    await t.test('current answers, explicit wants and closures retain precedence over learned interest',async()=>{
      const explicit=await recommendationPreferences(f.query,reader,{interests:['人文'],pace:'relaxed'});
      assert.equal((await interestQuestion(explicit)).options[0],'人文');
      assert.equal((await draft(explicit)).result.days[0].stops[0].id,museum.id);
      const learned=await preferences(),points=[{...museum,wanted:true},garden];
      const choose=input=>input.candidates.find(p=>p.name===garden.name).ref;
      const wanted=await draft(learned,{points,choose});
      assert.equal(wanted.result.days[0].stops[0].id,museum.id);
      assert.equal(wanted.result.days[0].stops[0].wanted,true);
      const closed=await draft(learned,{points,choose,closedId:museum.id});
      assert.ok(!closed.result.days.flatMap(d=>d.stops).some(p=>p.id===museum.id));
      assert.equal(closed.result.days[0].stops[0].id,garden.id);
    });

    await t.test('undo removes learned preference and restores the same question, order and draft',async()=>{
      for(const id of ids)assert.equal((await f.request('/api/posts/'+id+'/reactions',{user:'user',body:{kind:'save',active:false}})).status,200);
      await drainProfiles();
      const restored=await preferences();
      assert.deepEqual(await interestQuestion(restored),initialQuestion);
      assert.deepEqual(list(restored),initialList);
      assert.equal((await draft(restored)).result.days[0].stops[0].id,museum.id);
      assert.equal(Object.keys((await readProfile(f.query,reader)).travel).length,0);
    });
  }finally{await f.close();}
});
