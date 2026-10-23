/* 启动地点选择页面测试所需的模拟服务。 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouteSelection, amapEndpointParams } from '../server/route-selection.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const banner='人工构造的离线 UI 测试 · 无真实地图数据、无外部 API 调用';
const signer=createRouteSelection();
const places=[1,2].map(n=>({id:'test:'+n,name:'测试地点'+n,category:'attraction',subcategoryLabel:'测试景点',country:'CN',extract_region:'china',lat:31.2+n/100,lng:121.4+n/100,aliases:[],facts:{},source_timestamp:'2026-10-11T00:00:00Z',source_url:'#',coordinate_role:'representative_point_not_entrance'}));
const refs=[1,2].map(n=>({provider:'amap',id:'TEST_POI_'+n,location:`121.4${n}0100,31.2${n}0100`}));
const publicFiles=new Set(['catalog.html','catalog-ui.js','catalog.css','style.css','coordinates.js','navigation.js','travel-time.js','place-information.js','opening-panel.js','route-selection.js']);
const files=new Map([['/vendor/leaflet/leaflet.js','node_modules/leaflet/dist/leaflet.js'],['/vendor/leaflet/leaflet.css','node_modules/leaflet/dist/leaflet.css']]);
const send=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  try{
    if(url.pathname==='/api/catalog/coverage')return send(res,200,{status:'live',rows:2,regions:['TEST ONLY']});
    if(url.pathname==='/api/catalog/search')return send(res,200,{status:'live',elapsedMs:0,items:places});
    if(url.pathname==='/api/me')return send(res,200,{user:{id:'test-user'}});
    if(url.pathname.startsWith('/api/places/')&&url.pathname.endsWith('/match')){
      const id=decodeURIComponent(url.pathname.split('/')[3]),index=places.findIndex(p=>p.id===id);
      if(index<0)return send(res,404,{error:'Test place missing'});
      return send(res,200,{status:'live',provider:'高德地图 · 人工测试夹具',message:banner,items:[{id:refs[index].id,name:'测试地图候选'+(index+1),address:'合成地址，不对应真实入口',distanceMeters:12,score:0.9,confidence:'仅测试交互',...signer.issue('test-user',id,refs[index])}]});
    }
    if(url.pathname==='/api/routes'){
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)throw Error('Request too large');}
      const body=JSON.parse(raw),a=places.find(p=>p.id===body.from),b=places.find(p=>p.id===body.to);if(!a||!b)throw Error('Test endpoint missing');
      const selections={};if(body.fromMatchToken)selections.from=signer.resolve(body.fromMatchToken,'test-user',a.id,'amap');if(body.toMatchToken)selections.to=signer.resolve(body.toMatchToken,'test-user',b.id,'amap');
      const params=amapEndpointParams(a,b,body.mode,selections);
      return send(res,200,{status:'no_result',provider:'离线 UI 契约测试',message:'测试端点已收到：'+JSON.stringify(params)+'。没有请求真实路线。',alternatives:[],endpointSelections:selections});
    }
    const name=url.pathname.slice(1);let file=files.get(url.pathname);
    if(publicFiles.has(name))file=(['catalog.html','catalog-ui.js','catalog.css','style.css'].includes(name)?'archive/legacy-ui/':'public/')+name;
    if(!file){res.writeHead(404);return res.end('Not in test allowlist');}
    let content=await readFile(path.join(root,file));
    if(name==='catalog.html')content=Buffer.from(content.toString().replace('<body>','<body><aside style="position:sticky;top:0;z-index:9999;padding:14px;background:#fff0be;color:#5d3d00;font-weight:bold">'+banner+'</aside>'));
    const ext=path.extname(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[ext]+'; charset=utf-8','Cache-Control':'no-store',
      'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'"});res.end(content);
  }catch(error){send(res,error.status||400,{error:error.message});}
});
server.listen(8795,'127.0.0.1',()=>console.log(banner+'\nhttp://127.0.0.1:8795/catalog.html'));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
