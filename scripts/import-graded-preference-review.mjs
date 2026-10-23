/* 导入人工分级评分并汇总推荐评审结果。 */

import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {digest,validateGradedAnswers,summarizeGraded,compareGraded} from './lib/graded-preference-review.mjs';
const [flag,...files]=process.argv.slice(2);
if(flag!=='--local'||files.length>100||process.env.NODE_ENV==='production')throw Error('Use --local [final answer files]');
const root=new URL('../validation/graded-preference-review/',import.meta.url);
const study=JSON.parse(await readFile(new URL('study.json',root),'utf8')),protocol=JSON.parse(await readFile(new URL('protocol-private.json',root),'utf8'));
const answers=[];
for(const file of files){const raw=await readFile(file);if(raw.length>131072)throw Error('Answer bound exceeded');answers.push(validateGradedAnswers(study,JSON.parse(raw)));}
const report=summarizeGraded(study,protocol,answers);
const frozen=JSON.parse(await readFile(new URL('scores-private.json',root),'utf8'));
report.modelDiagnostic=compareGraded(study,protocol,frozen,answers);
await mkdir(new URL('answers/',root),{recursive:true});
for(const value of answers){const path=new URL('answers/'+value.reviewerId+'-'+digest(value).slice(0,16)+'.json',root),raw=JSON.stringify(value,null,2);try{await writeFile(path,raw,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await readFile(path,'utf8')!==raw)throw e;}}
const target=new URL('scored-analysis-'+digest({answers,frozen}).slice(0,16)+'.json',root),raw=JSON.stringify(report,null,2);
try{await writeFile(target,raw,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await readFile(target,'utf8')!==raw)throw e;}
console.log(JSON.stringify({status:report.status,reviewerCount:report.reviewerCount,diagnosticOnly:true,activationAllowed:false}));
