import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {tripMutationHandler} from '../server/services/trip-mutations.mjs';

test('TRIP-008 move persists insertion order, history and other-day isolation',
  {skip:process.env.TEST_ITERATION!=='1'},async()=>{
  const f=await iterationFixture({schemas:['schema.sql']});
  try{
    const id=randomUUID(),stops=['A','B','C','D'].map((name,i)=>({id:'move-'+name,name,city:'上海',category:'attraction',lat:31.2+i*.0001,lng:121.4,duration_min:30}));
    const plan={schemaVersion:'journey/2',pace:'balanced',cities:[{id:'shanghai',name:'上海'}],days:[{city:'上海',date:'2026-10-24',stops},{city:'上海',date:'2026-10-25',stops:[{...stops[0],id:'other-day'}]}]};
    await f.query("INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'move regression',$3,$4)",[id,f.users.user.id,{},plan]);
    await f.query("INSERT INTO trip_versions(trip_id,version,plan,reason) VALUES($1,1,$2,'initial')",[id,plan]);
    const ownTrip=async(id,user,c,lock)=>{
      const row=(await c.query('SELECT * FROM trips WHERE id=$1 AND user_id=$2'+(lock?' FOR UPDATE':''),[id,user])).rows[0];
      if(!row)throw Object.assign(Error('missing'),{status:404});return row;
    };
    f.app.patch('/api/trips/:id',f.auth,tripMutationHandler({transaction:f.transaction,ownTrip}));
    await f.start();
    const request={version:1,operation:{type:'move',day:0,placeId:'move-A',to:3}};
    const response=await f.request('/api/trips/'+id,{user:'user',method:'PATCH',body:request});
    assert.equal(response.status,200);assert.equal(response.data.version,2);
    const saved=(await f.query('SELECT * FROM trips WHERE id=$1',[id])).rows[0];
    assert.deepEqual(saved.plan.days[0].stops.map(p=>p.name),['B','C','D','A']);
    assert.deepEqual(saved.plan.days[1],plan.days[1]);
    const versions=(await f.query('SELECT version,plan FROM trip_versions WHERE trip_id=$1 ORDER BY version',[id])).rows;
    assert.deepEqual(versions.map(v=>v.version),[1,2]);
    assert.deepEqual(versions[0].plan,plan);
    assert.deepEqual(versions[1].plan,saved.plan);
    assert.equal((await f.request('/api/trips/'+id,{user:'user',method:'PATCH',body:request})).status,409);
    assert.equal((await f.request('/api/trips/'+id,{user:'other',method:'PATCH',body:{...request,version:2}})).status,404);
  }finally{await f.close();}
});
