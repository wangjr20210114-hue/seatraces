/* 启动推荐偏好盲评页面并保存选择。 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateAnswers } from './lib/preference-review.mjs';
import { saveReview } from './lib/preference-review-store.mjs';
export function reviewServer({study,html,save}) {
  const server = createServer(async (req,res) => {
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify(value));};
    const expected='127.0.0.1:'+res.socket.localPort;
    if(req.headers.host!==expected)return json(403,{error:'Invalid host'});
    if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});return res.end(html);}
    if(req.method!=='POST'||req.url!=='/answers')return json(404,{error:'Not found'});
    if(req.headers.origin!=='http://'+expected||req.headers['content-type']!=='application/json')return json(403,{error:'Same-origin JSON required'});
    if(Number(req.headers['content-length'])>65536){req.resume();return json(413,{error:'Answers too large'});}
    try {
      const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>65536){json(413,{error:'Answers too large'});return;}chunks.push(part);}
      const answers=validateAnswers(study,JSON.parse(Buffer.concat(chunks).toString()));await save(answers);json(200,{saved:true});
    } catch(e){json(400,{error:'Invalid answers or local save failed; download answers instead'});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length!==3 || process.argv[2]!=='--local' || process.env.NODE_ENV==='production')throw Error('Use --local; this server never connects to production');
  const root=new URL('../validation/preference-review/',import.meta.url),study=JSON.parse(await readFile(new URL('study.json',root))),protocol=JSON.parse(await readFile(new URL('protocol-private.json',root))),html=await readFile(new URL('SeaTraces-推荐盲评.html',root));
  const server=reviewServer({study,html,save:answers=>saveReview(new URL('answers/',root),study,protocol,answers)});
  server.listen(8796,'127.0.0.1',()=>console.log('Blind review: http://127.0.0.1:8796/ (local only; no production writes)'));
}
