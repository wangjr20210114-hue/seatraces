/* 执行智能功能检查并保存测试结果。 */

import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
const files=['adaptive-questions','agent-compound','agent','feedback-dimensions','weather','weather-http','feed-pager','recommendation-adaptation','place-descriptions','day-alternatives','intelligent-planning-http','official-facts','tracing','mail-outbox','tencent-ses'].map(x=>'test/'+x+'.test.mjs');
const env={...process.env,DOTENV_CONFIG_PATH:'.runtime/no-provider-env',OFFICIAL_FACT_AUTO_REFRESH:'false'};
for(const k of Object.keys(env))if(/^(AMAP|DEEPSEEK|GOOGLE|OSM|SMTP|SES_|MAIL|QWEATHER|DATABASE_URL)/.test(k))delete env[k];
for(const k of ['ADAPTIVE','AGENT','FEEDBACK_DIMENSIONS','WEATHER_HTTP','RECOMMENDATION_ADAPT','PERSONAL','INTELLIGENT_PLANNING','OFFICIAL_FACTS','TRACING','MAIL_OUTBOX'])env['TEST_'+k]='1';
delete env.TEST_URL;const begin=Date.now();let output='';
const child=spawn(process.execPath,['--max-old-space-size=320','--test','--test-concurrency=1',...files],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
for(const stream of [child.stdout,child.stderr])stream.on('data',v=>{output+=v.toString();});
const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
await mkdir('validation/intelligence/final',{recursive:true});await writeFile('validation/intelligence/final/features.log',output);
const record={finishedAt:new Date().toISOString(),elapsedSeconds:(Date.now()-begin)/1000,files,heapLimitMiB:320,exitCode:code,passed:Number(output.match(/ℹ pass (\d+)/)?.[1]),failed:Number(output.match(/ℹ fail (\d+)/)?.[1]),skipped:Number(output.match(/ℹ skipped (\d+)/)?.[1]),scope:'isolated localhost schemas, deterministic providers, no production or real email'};
await writeFile('validation/intelligence/final/features.json',JSON.stringify(record,null,2));console.log(JSON.stringify(record));
if(code)console.log(output.slice(-10000));process.exitCode=code||0;
