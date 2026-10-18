import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { hash, validateAnswers, summarizeReview } from './preference-review.mjs';

// Keep revisions as separate evidence; identical resubmissions are idempotent.
// A reviewer UUID is one participant, regardless of how often they submit.
export async function saveReview(directory, study, protocol, input) {
  const answers=validateAnswers(study,input), summary=summarizeReview(study,protocol,answers);
  const name=answers.reviewerId+'-'+hash(answers).slice(0,16), path=new URL(name+'.json',directory);
  const content=JSON.stringify(answers,null,2);
  await mkdir(directory,{recursive:true});
  try { await writeFile(path,content,{flag:'wx'}); }
  catch(e) { if(e.code!=='EEXIST')throw e; if(await readFile(path,'utf8')!==content)throw Error('Existing answer file differs; refusing overwrite'); }
  await writeFile(new URL(name+'.summary.json',directory),JSON.stringify(summary,null,2));
  return {saved:true,reviewerId:answers.reviewerId,file:name+'.json',diagnosticOnly:true,activationAllowed:false};
}
