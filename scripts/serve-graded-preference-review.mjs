import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
export function gradedReviewServer(html){
 const server=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  if(req.headers.host!=='127.0.0.1:'+res.socket.localPort){res.writeHead(403);return res.end();}
  if(req.method!=='GET'||req.url!=='/'){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(html);
 });server.requestTimeout=15000;server.headersTimeout=10000;return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.slice(2).join(' ')!=='--local'||process.env.NODE_ENV==='production')throw Error('Only --local');
 const html=await readFile(new URL('../validation/graded-preference-review/SeaTraces-旅行内容评价.html',import.meta.url));
 const server=gradedReviewServer(html);server.listen(8798,'127.0.0.1',()=>console.log('Graded review: http://127.0.0.1:8798/; local only; answers downloaded, never sent to server.'));
}
