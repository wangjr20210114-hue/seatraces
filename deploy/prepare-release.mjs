import { readFile,writeFile,mkdir,copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'dotenv';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'.runtime/backend-deploy');
await mkdir(output,{recursive:true,mode:0o700});
const env=parse(await readFile(path.join(root,'.env')));
// Never transfer the local DB password, SSH credentials, cached sessions, or
// arbitrary workstation settings into the server's application environment.
const keys=['AMAP_KEY','AMAP_POI_VERSION','AMAP_JS_KEY','AMAP_JS_SECURITY_CODE','DEEPSEEK_API_KEY','DEEPSEEK_MODEL','API_MONTHLY_BUDGET_CNY','API_DAILY_REQUEST_LIMIT','AMAP_DAILY_REQUEST_LIMIT','DEEPSEEK_DAILY_REQUEST_LIMIT','API_REQUEST_RESERVE_CNY','SCENIC_MODEL_GROUPING_ENABLED','OVERSEAS_MAP_PROVIDER','SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASSWORD','SMTP_FROM'];
const lines=keys.filter(k=>env[k]).map(k=>{
  if(/[\r\n]/.test(env[k])) throw Error('Unexpected multiline setting: '+k);
  return k+'='+env[k];
});
await writeFile(path.join(output,'providers.env'),lines.join('\n')+'\n',{mode:0o600});
const archive=path.join(output,'release.tar.gz');
const args=['-czf',archive,'--exclude=__pycache__','--exclude=*.pyc','-C',root,'server','public','contracts','data/editorial','deploy','package.json','package-lock.json','Dockerfile','.dockerignore'];
const result=spawnSync('tar',args,{encoding:'utf8',windowsHide:true});
if(result.status!==0)throw Error(result.stderr || 'Source archive failed');
const bytes=await readFile(archive);
const manifest={createdAt:new Date().toISOString(),sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,providerSettings:keys.filter(k=>!!env[k])};
await writeFile(path.join(output,'release-manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest));
