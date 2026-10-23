/* 汇总多份人工偏好评审结果。 */

import {readFile,readdir,stat,writeFile} from 'node:fs/promises';
import {aggregateReviews,renderAnalysis} from './lib/preference-review-analysis.mjs';
import {hash} from './lib/preference-review.mjs';

const args=process.argv.slice(2);
if(args[0]!=='--local'||args.slice(1).some(x=>x.startsWith('--'))||process.env.NODE_ENV==='production')throw Error('Use --local [explicit final answer files]; offline only');
const root=new URL('../validation/preference-review/',import.meta.url),study=JSON.parse(await readFile(new URL('study.json',root))),protocol=JSON.parse(await readFile(new URL('protocol-private.json',root)));
const {protocolId,...base}=study;if(hash(base)!==protocolId)throw Error('Frozen study checksum mismatch');
let files=args.slice(1);
if(!files.length){
  const names=await readdir(new URL('answers/',root)).catch(e=>{if(e.code!=='ENOENT')throw e;return [];});
  files=names.filter(x=>x.endsWith('.json')&&!x.endsWith('.summary.json')).sort().map(x=>new URL('answers/'+x,root));
}
if(files.length>1000)throw Error('Answer file count exceeds bound');
const inputs=[];
for(const file of files){if((await stat(file)).size>65536)throw Error('Answer file exceeds 64 KiB');inputs.push(JSON.parse(await readFile(file,'utf8')));}
const report=aggregateReviews(study,protocol,inputs);
await writeFile(new URL('analysis.json',root),JSON.stringify(report,null,2));
await writeFile(new URL('analysis.md',root),renderAnalysis(report));
console.log(JSON.stringify({status:report.status,reviewerCount:report.reviewerCount,diagnosticOnly:true,activationAllowed:false}));
