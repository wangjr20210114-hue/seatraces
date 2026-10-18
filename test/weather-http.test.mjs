import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {iterationFixture} from './helpers/iteration-db.mjs';
import {installWeatherRoutes} from '../server/services/weather.mjs';
test('weather and alert HTTP endpoints scope trips, cache alerts and distinguish unavailable from no active events',
 {skip:process.env.TEST_WEATHER_HTTP!=='1',timeout:60000},async()=>{
  const f=await iterationFixture({schemas:['schema.sql','weather-schema.sql']});
  try{
    const id=randomUUID(),day=new Date().toISOString().slice(0,10);let weatherCalls=0,alertCalls=0;
    await f.query("INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,'天气验收','{}',$3)",[id,f.users.user.id,{
      cities:[{id:'sh',country:'CN'}],days:[{cityId:'sh',date:day,stops:[{id:'museum',name:'博物馆',traits:{tourism:'museum'}}]}],
    }]);
    installWeatherRoutes(f.app,{auth:f.auth,query:f.query,service:{get:async()=>{weatherCalls++;return {status:'available',forecast:{day:'雨'},advice:'indoor_alternative'};}},
      alerts:async()=>{alertCalls++;await new Promise(r=>setTimeout(r,10));return {status:'available',items:[]};}});
    await f.start();const url='/api/journey/trips/'+id;
    assert.equal((await f.request(url+'/weather',{user:null})).status,401);
    assert.equal((await f.request(url+'/weather',{user:'other'})).status,404);assert.equal(weatherCalls,0);
    assert.equal((await f.request(url+'/weather?day=30',{user:'user'})).status,400);
    const r=await f.request(url+'/weather',{user:'user'});assert.equal(r.status,200);assert.equal(r.data.indoorStops[0].id,'museum');
    assert.equal((await f.request(url+'/weather-alerts',{user:'other'})).status,404);assert.equal(alertCalls,0);
    const rs=await Promise.all(Array.from({length:20},()=>f.request(url+'/weather-alerts',{user:'user'})));
    assert.ok(rs.every(r=>r.status===200&&r.data.status==='available'));assert.equal(alertCalls,1);
    await f.request(url+'/weather-alerts',{user:'user'});assert.equal(alertCalls,1);
  }finally{await f.close();}
});
