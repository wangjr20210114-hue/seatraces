import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import {createSourceCheck} from '../server/request-source.mjs';

async function fixture(t,options){
  const app=express();let nickname='unchanged';
  app.use(express.json(),createSourceCheck(options));
  app.get('/me',(req,res)=>res.json({nickname}));
  app.options('/me',(req,res)=>res.sendStatus(204));
  app.patch('/me',(req,res)=>{nickname=req.body.nickname;res.json({nickname});});
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const base='http://127.0.0.1:'+server.address().port;
  return {base,read:async()=>(await(await fetch(base+'/me')).json()).nickname,
    write:headers=>fetch(base+'/me',{method:'PATCH',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({nickname:'changed'})})};
}

test('unsafe writes reject missing markers, untrusted/null origins and cross-site metadata without changing data',async t=>{
  const f=await fixture(t,{production:true,appOrigin:'https://trip.example/'});
  const rejected=[
    {},{Origin:'https://trip.example'},
    {'X-Seatraces':'1',Origin:'https://outside.invalid'},
    {'X-Seatraces':'1',Origin:'null'},
    {'X-Seatraces':'1',Origin:''},
    {'X-Seatraces':'1',Origin:'https://trip.example.evil.invalid'},
    {'X-Seatraces':'1',Origin:'https://trip.example:8443'},
    {'X-Seatraces':'1',Origin:'https://trip.example/path'},
    {'X-Seatraces':'1',Origin:'https://trip.example https://outside.invalid'},
    {'X-Seatraces':'1',Origin:'https://trip.example','Sec-Fetch-Site':'cross-site'},
    {'X-Seatraces':'1','Sec-Fetch-Site':'cross-site'},
    {'X-Seatraces':'1',Origin:'https://outside.invalid','X-Forwarded-Host':'outside.invalid','X-Forwarded-Proto':'https',Host:'outside.invalid'},
  ];
  for(const headers of rejected){
    const response=await f.write(headers);assert.equal(response.status,403,JSON.stringify(headers));
    assert.equal(await f.read(),'unchanged');
  }
  assert.equal((await f.write({'X-Seatraces':'1',Origin:'https://trip.example','Sec-Fetch-Site':'same-origin'})).status,200);
  assert.equal(await f.read(),'changed');
});

test('marker-authenticated internal calls and safe reads remain usable',async t=>{
  const f=await fixture(t,{production:true,appOrigin:'https://trip.example'});
  assert.equal((await f.write({'X-Seatraces':'1'})).status,200);
  assert.equal((await fetch(f.base+'/me',{headers:{Origin:'https://outside.invalid'}})).status,200);
  assert.equal((await fetch(f.base+'/me',{method:'OPTIONS',headers:{Origin:'https://outside.invalid'}})).status,204);
});

test('development accepts its configured frontend and loopback ports without trusting forwarding headers',async t=>{
  const f=await fixture(t,{production:false,appOrigin:'http://127.0.0.1:19888'});
  for(const Origin of ['http://127.0.0.1:19888','http://127.0.0.1:8788','http://localhost:8787',f.base]){
    assert.equal((await f.write({'X-Seatraces':'1',Origin})).status,200,Origin);
  }
  assert.equal((await f.write({'X-Seatraces':'1',Origin:'https://outside.invalid','X-Forwarded-Host':'outside.invalid'})).status,403);
});

test('production without a public origin fails closed for Origin-bearing writes',async t=>{
  const f=await fixture(t,{production:true,appOrigin:''});
  assert.equal((await f.write({'X-Seatraces':'1',Origin:f.base})).status,403);
});

test('invalid public-origin configuration is rejected at startup',()=>{
  for(const appOrigin of ['null','ftp://trip.example','https://user:secret@trip.example','https://trip.example/path','https://trip.example?q=1']){
    assert.throws(()=>createSourceCheck({appOrigin}),/APP_ORIGIN/);
  }
});
