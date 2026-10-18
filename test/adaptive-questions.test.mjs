import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adaptiveQuestions,adaptiveInput,installAdaptiveQuestions} from '../server/services/adaptive-questions.mjs';
import {tripPreferences,travelTiming} from '../server/agent/travel-language.mjs';
import {createJourneyDraft,journeyAnswers} from '../server/services/journey-draft.mjs';
import {iterationFixture} from './helpers/iteration-db.mjs';

test('known conditions skip questions; parents and low walking branch without inventing answers',()=>{
  const text='明早去上海，两天，带父母，不想走太多，之前去过外滩';
  const known=tripPreferences(text).values;
  assert.equal(known.companion,'parents');assert.equal(known.transport,'fewWalking');assert.deepEqual(known.visitedNames,['外滩']);
  assert.equal(travelTiming(text,{now:new Date('2026-10-18T08:00:00Z')}).end,'2026-10-20');
  const r=adaptiveQuestions({interests:['园林'],styleWeights:{园林:.9}},known);
  const ids=r.questions.map(q=>q.id);
  assert.ok(!ids.includes('companion')&&!ids.includes('transport'));
  assert.ok(ids.includes('walkingLimitKm')&&ids.includes('endBy')&&ids.includes('revisit'));
  assert.ok(ids.includes('interests'),'historical interests are not current consent');
  assert.match(r.questions.find(q=>q.id==='interests').title,/园林/);
  assert.equal(r.known.pace,undefined);assert.equal(r.known.endBy,undefined);
});

test('question structure responds to answers; current choice beats inferred topics and no unnecessary revisit question',()=>{
  const neutral=adaptiveQuestions({},{});assert.ok(!neutral.questions.some(q=>q.id==='revisit'||q.id==='walkingLimitKm'));
  const museum=adaptiveQuestions({styleWeights:{园林:.8}},{companion:'solo',interests:['人文'],pace:'balanced',transport:'balanced'});
  assert.deepEqual(museum.questions.map(q=>q.id),['travelFocus']);
  const ready=adaptiveQuestions({}, {...museum.known,travelFocus:'immersive'});
  assert.equal(ready.ready,true);assert.deepEqual(ready.defaults.interests,['人文']);
  assert.equal(ready.constraints.interests.source,'current_explicit');
  const family=adaptiveQuestions({}, {companion:'family',interests:['亲子']});assert.ok(family.questions.some(q=>q.id==='crowd'));
  assert.throws(()=>adaptiveInput.parse({answers:{admin:true}}));assert.throws(()=>adaptiveInput.parse({answers:{walkingLimitKm:Infinity}}));
  assert.throws(()=>adaptiveInput.parse({answers:{endBy:'25:00'}}));
  assert.equal(tripPreferences('不带父母，没去过外滩').values.companion,undefined);
  assert.equal(tripPreferences('不带父母，没去过外滩').values.visitedNames,undefined);
  assert.equal(tripPreferences('如果带父母，下午五点前结束').values.endBy,undefined);
});

test('depth, excluded places and explicit finish time change real draft scheduling',async()=>{
  let captured;
  const draft=createJourneyDraft({model:async(_prompt,input)=>{captured=input;return {days:input.dates.map(date=>({date,places:input.candidates.map(p=>p.ref)}))};},opening:async()=>null});
  const city={id:'city',name:'上海',lat:31.2,lng:121.4},points=[
    {id:'a',name:'外滩',category:'attraction',lat:31.2,lng:121.4,wanted:true},
    {id:'b',name:'城市博物馆',category:'attraction',traits:{tourism:'museum'},lat:31.201,lng:121.4},
    {id:'c',name:'公园',category:'nature',lat:31.202,lng:121.4},
  ];
  const result=await draft({origin:{label:'上海'},start:'2027-06-20',end:'2027-06-20'},[city],{city:points},journeyAnswers.parse({
    interests:['人文'],avoidPlaceNames:['外滩'],travelFocus:'immersive',endBy:'13:00',walkingLimitKm:3,
  }));
  assert.ok(!captured.candidates.some(p=>p.name==='外滩'),'explicit exclusion beats wanted');
  assert.equal(captured.candidates.find(p=>p.name==='城市博物馆').stayMinutes,150);
  assert.equal(result.days[0].timeBudget.end,780);
  assert.ok(result.days[0].stops.every(p=>p.leave<='13:00'));
  assert.equal(result.days[0].walking.status,'planning_allowance_excludes_internal_walks');
});

test('adaptive endpoint preserves old body, validates ownership, changes branches and stays bounded under concurrency',
 {skip:process.env.TEST_ADAPTIVE!=='1',timeout:60000},async()=>{
  const f=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql','agent/schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql']});
  try{
    const id=randomUUID();await f.query('INSERT INTO journey_sessions(id,user_id,request) VALUES($1,$2,$3)',[id,f.users.user.id,{}]);
    installAdaptiveQuestions(f.app,{auth:f.auth,query:f.query,travelHabit:async()=>({styleWeights:{园林:.9}}),ownSession:async(id,uid)=>{
      const r=(await f.query('SELECT * FROM journey_sessions WHERE id=$1 AND user_id=$2',[id,uid])).rows[0];if(!r)throw Object.assign(Error('missing'),{status:404});return r;
    }});await f.start();
    const url='/api/journey/sessions/'+id+'/questions';
    assert.equal((await f.request(url,{user:'other',body:{}})).status,404);
    assert.equal((await f.request(url,{user:'user',body:{answers:{isAdmin:true}}})).status,400);
    const old=await f.request(url,{user:'user',body:{}});assert.equal(old.status,200);assert.ok(old.data.questions.length);
    const answers={companion:'parents',transport:'fewWalking',interests:['园林'],pace:'relaxed'};
    const result=await f.request(url,{user:'user',body:{answers}});
    assert.ok(result.data.questions.some(q=>q.id==='walkingLimitKm'));assert.ok(result.data.questions.some(q=>q.id==='travelFocus'));
    assert.ok(!result.data.questions.some(q=>q.id==='companion'||q.id==='interests'));
    const changed=await f.request(url,{user:'user',body:{answers:{companion:'solo',transport:'balanced',interests:[],pace:'balanced'}}});assert.equal(changed.data.ready,true);
    const responses=await Promise.all(Array.from({length:20},()=>f.request(url,{user:'user',body:{answers}})));
    assert.ok(responses.every(r=>r.status===200&&r.data.questions.length<=8));
    assert.equal((await f.query('SELECT questions->>\'schemaVersion\' version FROM journey_sessions WHERE id=$1',[id])).rows[0].version,'adaptive-questions/1');
  }finally{await f.close();}
});
