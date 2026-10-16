import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoveryCard, publishRoute, routePreview, routeThumbnail } from '../public/discovery.js';

test('discovery card escapes author and route data and shows ordered stops', () => {
  const html = discoveryCard({ title: '<img onerror=alert(1)>', nickname: '<script>', snapshot: { cities: ['城市'], days: [{city:'城市',stops:[{name:'A'},{name:'B'}]}] } });
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script>'));
  assert.match(html, /1 天 · 2 个景点/); assert.ok(html.indexOf('<li>A') < html.indexOf('<li>B'));
});

test('PostgreSQL: save stays private; explicit publish is owned, idempotent, sanitized and visible in my posts', { skip: process.env.TEST_DISCOVERY !== '1' }, async () => {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const { default: express } = await import('express');
  const { installDiscoveryRoutes } = await import('../server/services/discovery.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'seatraces-discovery-'));
  const db = new EmbeddedPostgres({databaseDir:join(dir,'db'), user:'postgres', password:randomUUID(), port:Number(process.env.TEST_DISCOVERY_PORT || 55439), persistent:false, onLog:()=>{}, onError:()=>{}});
  let client, server;
  try {
    await db.initialise(); await db.start(); client=db.getPgClient(); await client.connect();
    for (const file of ['schema.sql','citywalk-schema.sql','discovery-schema.sql'])
      await client.query(await readFile(new URL('../server/'+file,import.meta.url),'utf8'));
    const owner=randomUUID(), viewer=randomUUID(), trip=randomUUID(), walk=randomUUID();
    for (const [id,name] of [[owner,'author'],[viewer,'viewer']]) await client.query('INSERT INTO users(id,username,password_hash,nickname) VALUES($1,$2,$3,$2)',[id,name,'test']);
    // Simulate the prior version, then ensure migration removes automatic publication.
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
    const edit=async(body,user=owner,id=published.data.id)=>{
      const response=await fetch(base+'/api/discovery/posts/'+id,{method:'PATCH',headers:{'content-type':'application/json','x-user':user},body:JSON.stringify(body)});
      return {status:response.status,data:response.headers.get('content-type')?.includes('json')?await response.json():null};
    };
    const edited={title:' 我的杭州漫游 ',body:' 第一天走西湖。\n第二天慢慢逛。 '};
    assert.equal((await edit(edited,'')).status,401);
    assert.equal((await edit(edited,viewer)).status,404);
    assert.equal((await edit(edited,owner,randomUUID())).status,404);
    assert.equal((await edit({...edited,title:' '})).status,400);
    assert.equal((await edit({...edited,body:'x'.repeat(4001)})).status,400);
    assert.equal((await edit({...edited,user_id:viewer})).status,400);
    const saved=await edit(edited);
    assert.equal(saved.status,200);
    assert.equal(saved.data.title,edited.title.trim());
    assert.equal(saved.data.body,edited.body.trim());
    assert.deepEqual(saved.data.snapshot,published.data.snapshot);
    assert.equal((await request('/api/discovery/mine')).data.items[0].title,edited.title.trim());
    assert.equal((await request('/api/discovery/publish',{kind:'journey',id:trip})).data.title,edited.title.trim());

    assert.equal((await request('/api/discovery/publish',{kind:'journey',id:fresh})).status,200);
    assert.equal((await request('/api/discovery/publish',{kind:'citywalk',id:walk})).status,200);
    const mine=(await request('/api/discovery/mine?limit=2')).data;
    assert.equal(mine.items.length,2); assert.equal(mine.hasMore,true); assert.ok(mine.items.every(p=>p.isOwn));
    assert.equal((await request('/api/discovery/mine?limit=2&offset=2')).data.items.length,1);
    assert.equal((await request('/api/discovery/mine',null,viewer)).data.items.length,0);
    // Editing a private route never changes the published snapshot without another click.
    const before=(await client.query('SELECT snapshot FROM posts WHERE trip_id=$1',[trip])).rows[0].snapshot;
    await client.query('UPDATE trips SET plan=$2 WHERE id=$1',[trip,JSON.stringify({...plan,days:[]})]);
    assert.deepEqual((await client.query('SELECT snapshot FROM posts WHERE trip_id=$1',[trip])).rows[0].snapshot,before);
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await client?.end(); await db.stop().catch(()=>{}); await rm(dir,{recursive:true,force:true});
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
  assert.deepEqual(navigation,['/discover']); assert.ok(messages.some(m=>m.includes('我的发布')));
});


test('route thumbnail handles missing, invalid, single and repeated coordinates safely', () => {
  assert.match(routeThumbnail({days:[]}), /暂未提供景点坐标/);
  const snapshot = {days:[{stops:[{name:'missing',lat:null,lng:120},{name:'bad',lat:91,lng:120},{name:'A',lat:30,lng:120},{name:'<script>',lat:30,lng:120}]}]};
  assert.deepEqual(routePreview(snapshot).map(p=>p.number), [3,4]);
  const html=routeThumbnail(snapshot);
  assert.match(html, /<svg/); assert.match(html, /data-route-map/);
  assert.ok(!html.includes('<script>')); assert.ok(!/NaN|Infinity/.test(html));
  assert.ok(!/NaN|Infinity/.test(routeThumbnail({days:[{stops:[{lat:0,lng:0}]}]})));
  assert.match(discoveryCard({id:'a',isOwn:true,snapshot}), /data-edit/);
  assert.ok(!discoveryCard({id:'a',isOwn:false,snapshot}).includes('data-edit'));
});
