/* 验证发现页与路线分享。 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { discoveryCard, publishRoute } from '../public/discovery.js';

test('discovery card escapes author and card content and labels synthetic posts', () => {
  const html = discoveryCard({ id:'card',title: '<img onerror=alert(1)>', nickname: '<script>',excerpt:'<b>正文</b>',is_synthetic:true });
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);assert.match(html,/&lt;b&gt;正文&lt;\/b&gt;/);assert.match(html,/模拟内容/);assert.match(html,/#\/post\/card/);
});

test('PostgreSQL: save stays private; explicit publish is owned, idempotent, sanitized and visible in my posts', { skip: process.env.TEST_DISCOVERY !== '1' }, async () => {
  const {iterationFixture}=await import('./helpers/iteration-db.mjs');
  const { default: express } = await import('express');
  const { installDiscoveryRoutes } = await import('../server/services/discovery.mjs');
  const fixture=await iterationFixture({schemas:['schema.sql','citywalk-schema.sql','discovery-schema.sql']});
  const client={query:fixture.query};let server;
  try {
    const owner=randomUUID(), viewer=randomUUID(), trip=randomUUID(), walk=randomUUID();
    for (const [id,name] of [[owner,'author'],[viewer,'viewer']]) await client.query('INSERT INTO users(id,username,password_hash,nickname) VALUES($1,$2,$3,$2)',[id,name,'test']);
    await client.query(`CREATE FUNCTION sync_route_discovery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO posts(id,user_id,trip_id,title,body,snapshot,auto_shared) VALUES(gen_random_uuid(),NEW.user_id,NEW.id,'old','old','{}',true);
      RETURN NEW; END $$;
      CREATE TRIGGER trips_discovery_sync AFTER INSERT ON trips FOR EACH ROW EXECUTE FUNCTION sync_route_discovery()`);
    const plan={cities:[{name:'杭州'}],days:[{city:'杭州',date:'2030-01-01',stops:[{id:'lake',name:'西湖',lat:30,lng:120,visitHistory:{secret:'private'},wanted:true}]}]};
    await client.query('INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,$3,$4,$5)',[trip,owner,'杭州漫游',JSON.stringify({origin:'私人地址',interests:['自然']}),JSON.stringify(plan)]);
    for (let i=0;i<2;i++) await client.query(await readFile(new URL('../server/discovery-schema.sql',import.meta.url),'utf8'));
    assert.equal((await client.query('SELECT * FROM pg_trigger WHERE tgname IN (\'trips_discovery_sync\',\'citywalks_discovery_sync\')')).rowCount,0);
    const fresh=randomUUID();
    await client.query('INSERT INTO trips(id,user_id,title,request,plan) VALUES($1,$2,$3,$4,$5)',[fresh,owner,'新路线','{}',JSON.stringify(plan)]);
    await client.query('UPDATE trips SET title=$2 WHERE id=$1',[fresh,'修改草稿']);
    assert.equal((await client.query('SELECT * FROM posts WHERE trip_id=$1',[fresh])).rowCount,0);
    await client.query('INSERT INTO citywalks(id,user_id,title,city,stops,distance_m) VALUES($1,$2,$3,$4,$5,1000)',[walk,owner,'散步',JSON.stringify({name:'杭州'}),JSON.stringify([{id:'a',name:'A'},{id:'b',name:'B'}])]);
    assert.equal((await client.query('SELECT * FROM posts WHERE citywalk_id=$1',[walk])).rowCount,0);
    const app=express(); app.use(express.json());
    const auth=(req,res,next)=>{ if (![owner,viewer].includes(req.headers['x-user'])) return res.sendStatus(401); req.user={id:req.headers['x-user']};next(); };
    installDiscoveryRoutes(app,{auth,query:(sql,args)=>client.query(sql,args)});
    app.use((error,req,res,next)=>res.status(error.name==='ZodError'?400:500).json({error:error.message}));
    server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
    const base='http://127.0.0.1:'+server.address().port;
    const request=async(path,body,user=owner)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-user':user},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():null};};
    assert.equal((await request('/api/discovery/mine')).data.items.length,0,'legacy auto posts stay hidden');
    assert.equal((await request('/api/discovery/publish',{kind:'journey',id:trip},viewer)).status,404);
    assert.equal((await request('/api/discovery/publish',{kind:'journey',id:trip},'')).status,401);
    assert.equal((await request('/api/discovery/publish',{kind:'journey',id:'invalid'})).status,400);
    const published=await request('/api/discovery/publish',{kind:'journey',id:trip}); assert.equal(published.status,200);
    assert.equal(published.data.auto_shared,false);
    for (const secret of ['私人地址','2030-01-01','visitHistory','wanted']) assert.ok(!JSON.stringify(published.data.snapshot).includes(secret));
    assert.equal((await request('/api/discovery/publish',{kind:'journey',id:trip})).data.id,published.data.id);
    assert.equal((await request('/api/discovery/publish',{kind:'journey',id:fresh})).status,200);
    assert.equal((await request('/api/discovery/publish',{kind:'citywalk',id:walk})).status,200);
    const mine=(await request('/api/discovery/mine?limit=2')).data;
    assert.equal(mine.items.length,2); assert.equal(mine.hasMore,true); assert.ok(mine.items.every(p=>p.isOwn));
    assert.equal((await request('/api/discovery/mine?limit=2&offset=2')).data.items.length,1);
    assert.equal((await request('/api/discovery/mine',null,viewer)).data.items.length,0);
    const before=(await client.query('SELECT snapshot FROM posts WHERE trip_id=$1',[trip])).rows[0].snapshot;
    await client.query('UPDATE trips SET plan=$2 WHERE id=$1',[trip,JSON.stringify({...plan,days:[]})]);
    assert.deepEqual((await client.query('SELECT snapshot FROM posts WHERE trip_id=$1',[trip])).rows[0].snapshot,before);
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await fixture.close();
  }
});

test('publish button prevents concurrent duplicate requests and permits retry after failure', async () => {
  const button = {disabled:false,textContent:'发布到发现',isConnected:true};
  const calls=[], messages=[], navigation=[];
  let reject;
  const api=()=>{calls.push(1);return new Promise((resolve,fail)=>{reject=fail;});};
  const options={button,kind:'journey',id:'retry-test',api,navigate:path=>navigation.push(path),toast:message=>messages.push(message)};
  const pending=publishRoute(options);
  await publishRoute(options);
  assert.equal(calls.length,1); assert.equal(button.disabled,true);
  reject(Error('网络中断'));await pending;
  assert.equal(button.disabled,false); assert.equal(navigation.length,0);
  await publishRoute({...options,api:async()=>({id:'post'})});
  assert.deepEqual(navigation,['/compose/post?write=1']); assert.ok(messages.includes('网络中断'));
});
