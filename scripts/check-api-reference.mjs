// Keep the end-to-end documentation inventory tied to installed HTTP routes.
import { readFile, readdir, writeFile } from "node:fs/promises";
const files = [
  "server/index.mjs",
  "server/auth.mjs",
  "server/services/journey-service.mjs",
  "server/services/citywalk-service.mjs",
  "server/services/trip-services.mjs",
  "server/agent/routes.mjs",
  "server/services/discovery.mjs",
  "server/services/classic-citywalks.mjs",
  ...(await readdir('server/operations')).filter(name=>name.endsWith('.mjs')).sort().map(name=>'server/operations/'+name),
  "server/frontend.mjs",
];
// Expand the documented method/prefix in table headers so compact tables are
// checked against full routes without duplicating interface specifications.
function referenceText(text) {
  const lines=text.replaceAll('`','').split(/\r?\n/);
  let method='',prefix='';const expanded=[];
  for(const line of lines){
    if(!line.startsWith('|')){method='';prefix='';continue;}
    if(/接口/.test(line.split('|')[1]||'')){
      method=/\b(GET|POST|PUT|PATCH|DELETE)\b/.exec(line)?.[1]||'';
      prefix=/前缀\s*(\/[^）\s|]+)/.exec(line)?.[1]||'';
    }
    const cell=line.split('|')[1]?.trim()||'';
    const route=/^(?:(GET|POST|PUT|PATCH|DELETE)\s+)?(\/[^\s|]+)/.exec(cell);
    if(route&&(route[1]||method))expanded.push((route[1]||method)+' '+(route[2].startsWith('/api/')?'':prefix)+route[2]);
  }
  return lines.join('\n')+'\n'+expanded.join('\n');
}
const references = await Promise.all(['API_REFERENCE.md','ADMIN.md','CITYWALK_API.md'].map(async file=>({file,text:referenceText(await readFile(file,'utf8'))})));
const endpoints = [],
  missing = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const m of source.matchAll(
    /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*(\[[^\]]+\]|['"][^'"]+['"])/g,
  )) {
    for (const p of m[2].matchAll(/['"]([^'"]+)['"]/g)) {
      const path = (file.endsWith("/auth.mjs") ? "/api" : "") + p[1];
      if (
        !path.startsWith("/api/") &&
        !["/_AMapService/v4/map/styles", "/frontend-health"].includes(path)
      )
        continue;
      const method = m[1].toUpperCase(),
        key = method + " " + path;
      if (endpoints.some((e) => e.method + " " + e.path === key)) continue;
      const short = path.replace(/^\/api\//, "/");
      const reference=references.find(r=>r.text.includes(method+' '+path)||r.text.includes(method+' '+short));
      if (
        !reference &&
        path !== "/_AMapService/v4/map/styles"
      )
        missing.push(key);
      endpoints.push({
        method,
        path,
        source: file,
        line: source.slice(0, m.index).split("\n").length,
        reference: reference?.file||"API_REFERENCE.md",
      });
    }
  }
}
if (missing.length)
  throw Error("API reference entries missing: " + missing.join(", "));
await writeFile(
  "contracts/api-inventory.json",
  JSON.stringify(
    {
      schemaVersion: "api-inventory/1",
      description:
        "已安装的业务HTTP入口清单；参数、返回与副作用见各条 reference 指向的文档。不是agent工具注册表。",
      endpoints,
    },
    null,
    2,
  ) + "\n",
);
console.log("Documented HTTP operations: " + endpoints.length);
