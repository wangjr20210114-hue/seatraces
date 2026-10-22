// Full pending-place assessment. All model decisions are explicitly unverified.
// Existing provider/official hierarchy remains authoritative and untouched.
import {readdir,mkdir,unlink} from 'node:fs/promises';
import dotenv from 'dotenv';
import {localApiLimitsEnabled} from '../server/domain/api-limits.mjs';
import {atomicJSON,readJSON} from '../server/services/hierarchy-evidence.mjs';
import {hashJSON,hierarchyPlaceHash} from '../server/domain/scenic-hierarchy.mjs';
import {assessmentVersion,assessmentInstruction,buildAssessmentJobs,assessmentJobHash,validateAssessment} from '../server/domain/hierarchy-assessment.mjs';

const root=new URL('../',import.meta.url),dir=new URL('.runtime/deepseek-hierarchy/',root),args=new Set(process.argv.slice(2));
if(args.size!==1||![...args].every(a=>['--prepare','--run','--pilot','--status','--stop'].includes(a)))throw Error('Use --prepare, --run, --pilot (5 jobs), --status, or --stop');
await mkdir(dir,{recursive:true});
if(args.has('--status')){console.log(JSON.stringify(await readJSON(new URL('status.json',dir)),null,2));process.exit(0);}
if(args.has('--stop')){await atomicJSON(new URL('stop.json',dir),{at:new Date().toISOString()});console.log('Stop requested.');process.exit(0);}
dotenv.config({path:new URL('.env',root),quiet:true});
const local=await readJSON(new URL('.runtime/local.json',root));
process.env.DATABASE_URL=`postgresql://seatraces:${encodeURIComponent(local.password)}@127.0.0.1:${local.port}/seatraces`;
const {pool,query}=await import('../server/db.mjs');
const {loadParentChecks}=await import('../server/repositories/scenic-parents.mjs');
const {reserveHierarchyAssessment,settleHierarchyAssessment}=await import('../server/repositories/hierarchy-budget.mjs');
const {createDeepseekClient}=await import('../server/integrations/deepseek.mjs');
const {createJsonRequester}=await import('../server/integrations/http.mjs');
const status={version:assessmentVersion,status:'preparing',startedAt:new Date().toISOString(),commercialAmapCalls:0};
let connection,locked=false,lost=false;
const checkpoint=async extra=>{Object.assign(status,extra,{updatedAt:new Date().toISOString()});await atomicJSON(new URL('status.json',dir),status);};
const limitsEnabled=localApiLimitsEnabled();
const budget=limitsEnabled?Number(process.env.HIERARCHY_ASSESSMENT_BUDGET_CNY||20):null,model=process.env.DEEPSEEK_MODEL||'deepseek-flash';
if(model!=='deepseek-flash'||(limitsEnabled&&(!Number.isFinite(budget)||budget<=0||budget>200)))throw Error('Unsupported model or invalid batch budget');
try {
  connection=await pool.connect();connection.on('error',()=>{lost=true;});
  locked=(await connection.query('SELECT pg_try_advisory_lock(20261012,3) locked')).rows[0].locked;
  if(!locked){console.log('Assessment worker already running.');process.exitCode=1;}
  else {
    await checkpoint();
    const data=await readJSON(new URL('.runtime/scenic-hierarchy/geometry-result.json',root));
    const points=data.points.map(p=>({...p,mainlandCityVerified:true}));
    const checks=await loadParentChecks(points),confirmed=new Set([...checks].filter(([,r])=>['root','child'].includes(r.status)).map(([id])=>id));
    const hashes=new Map(points.map(p=>[p.id,hierarchyPlaceHash(p)]));
    const localResults=(await query("SELECT place_id,input_hash,result FROM scenic_hierarchy_results WHERE review_after>now() AND result->>'status'='child'")).rows;
    for(const r of localResults)if(hashes.get(r.place_id)===r.input_hash)confirmed.add(r.place_id);
    const registry=await readJSON(new URL('data/editorial/hierarchy-sources.json',root));
    const evidence=[];
    const evidenceDir=new URL('.runtime/scenic-hierarchy/evidence/',root);
    for(const name of await readdir(evidenceDir))if(name.endsWith('.json')) {
      const e=await readJSON(new URL(name,evidenceDir)),definition=registry.sources.find(s=>s.url===e.url);
      if(definition&&Date.now()-Date.parse(e.retrievedAt)>=0&&Date.now()-Date.parse(e.retrievedAt)<86400_000)evidence.push({...e,...definition});
    }
    const inputJobs=buildAssessmentJobs(data,confirmed,evidence);
    const jobs=inputJobs.map(input=>({hash:assessmentJobHash(input,model),input}));
    const batchHash=hashJSON(jobs.map(j=>j.hash)),provider='DeepSeekHierarchy:'+batchHash.slice(0,16);
    const plan={version:assessmentVersion,batchHash,provider,model,sourceHash:data.fingerprint,
      confirmed:confirmed.size,places:jobs.reduce((n,j)=>n+j.input.places.length,0),jobs:jobs.length,budgetCny:budget,
      withOptions:jobs.flatMap(j=>j.input.places).filter(p=>p.parentOptions.length).length,
      withOfficialEvidence:jobs.flatMap(j=>j.input.places).filter(p=>p.evidence.length).length,
      cities:[...new Set(points.map(p=>p.city))],preparedAt:new Date().toISOString()};
    await atomicJSON(new URL('plan.json',dir),plan);
    await atomicJSON(new URL('inputs.json',dir),jobs);
    await checkpoint({plan});
    if(args.has('--prepare')){await checkpoint({status:'prepared'});console.log(JSON.stringify(plan));}
    else {
      if(!process.env.DEEPSEEK_API_KEY)throw Object.assign(Error('Missing key'),{code:'model_not_configured'});
      await unlink(new URL('stop.json',dir)).catch(e=>{if(e.code!=='ENOENT')throw e;});
      let processed=0,completed=0,newCalls=0,failed=0,consecutiveFailures=0;
      const counts={child_candidate:0,independent_candidate:0,unknown:0};
      const runStart=new Date().toISOString();
      const jobTimes=[],jobCosts=[];
      await checkpoint({status:'running',completedJobs:0,totalJobs:jobs.length,totalPlaces:plan.places});
      for(const j of jobs) {
        if(lost||await readJSON(new URL('stop.json',dir))){status.status='paused';status.reason=lost?'database_lost':'stop_requested';break;}
        const path=new URL('jobs/'+j.hash+'.json',dir);
        let job=await readJSON(path);
        if(!job) {
          if(args.has('--pilot')&&newCalls>=5){status.status='pilot_complete';break;}
          let reservation,usage;
          const requester=createJsonRequester({reserve:async()=>{},timeoutMs:30000});
          const llm=createDeepseekClient({requestJSON:async(p,url,options)=>{
            reservation=await reserveHierarchyAssessment(provider,JSON.parse(options.body),budget);
            job={hash:j.hash,status:'attempting',startedAt:new Date().toISOString(),reservation,placeIds:j.input.places.map(p=>p.id)};
            await atomicJSON(path,job);
            newCalls++;
            const response=await requester(p,url,options);usage=response.usage;return response;
          }});
          try {
            const output=await llm(assessmentInstruction,j.input,{maxTokens:1800});
            job.output=output;job.status='received';
          } catch(error) {
            if(!job){status.status='paused';status.reason=error.code||'budget_or_configuration';break;}
            job.status='failed_no_automatic_retry';job.errorCode=error.code||'model_request_failed';
          }
          job.usage=usage||null;job.elapsedMs=Date.now()-Date.parse(job.startedAt);
          await atomicJSON(path,job); // Preserve a paid response even if settlement loses DB access.
          job.estimatedCny=await settleHierarchyAssessment(reservation,usage);
          await atomicJSON(path,job);
        }
        if(job.output) {
          try {job.assessments=validateAssessment(job.output,j.input);job.validation='accepted_as_unverified';}
          catch(error){job.validation='rejected';job.validationReason=error.message;}
        }
        if(job.validation==='accepted_as_unverified') {
          const records=job.assessments.map(a=>({...a,inputHash:hashes.get(a.placeId),jobHash:j.hash,model,
            assessedAt:job.startedAt,version:assessmentVersion,sourceHash:data.fingerprint}));
          await query(`UPDATE scenic_hierarchy_results h SET result=jsonb_set(h.result,'{modelAssessment}',r.value,true)
            FROM jsonb_to_recordset($1::jsonb) AS r(id text,input_hash text,value jsonb)
            WHERE h.place_id=r.id AND h.input_hash=r.input_hash`,[JSON.stringify(records.map(r=>({id:r.placeId,input_hash:r.inputHash,value:r})))]);
          for(const r of records)counts[r.verdict]++;
          processed+=records.length;consecutiveFailures=0;
        } else {failed++;consecutiveFailures++;}
        if(job.status==='received'&&Number.isFinite(job.elapsedMs))jobTimes.push(job.elapsedMs);
        if(Number.isFinite(job.estimatedCny))jobCosts.push(job.estimatedCny);
        await atomicJSON(path,job);
        completed++;
        const money=Number((await query('SELECT COALESCE(sum(reserved_cny),0) n FROM api_usage WHERE provider=$1',[provider])).rows[0].n);
        const meanMs=jobTimes.length?jobTimes.reduce((a,b)=>a+b,0)/jobTimes.length:null;
        const remaining=jobs.length-completed,remainingSeconds=meanMs?Math.ceil(remaining*(meanMs+200)/1000):null;
        const expectedCost=jobCosts.length?jobCosts.reduce((a,b)=>a+b,0)/jobCosts.length*jobs.length:null;
        await checkpoint({completedJobs:completed,assessedPlaces:processed,newCallsThisRun:newCalls,failedJobs:failed,
          counts,reservedOrEstimatedCny:money,estimatedTotalCny:expectedCost,
          estimate:remainingSeconds===null?null:{secondsRemaining:remainingSeconds,
            estimatedFinishAt:new Date(Date.now()+remainingSeconds*1000).toISOString(),measuredJobs:jobTimes.length},
          runningSeconds:Math.round((Date.now()-Date.parse(runStart))/1000)});
        if(completed%10===0)console.log(JSON.stringify({completedJobs:completed,totalJobs:jobs.length,assessedPlaces:processed,estimatedFinishAt:status.estimate?.estimatedFinishAt}));
        if(consecutiveFailures>=3){status.status='paused';status.reason='repeated_model_or_validation_failure';break;}
      }
      if(status.status==='running')status.status=failed?'complete_with_failed_jobs':'complete';
      await checkpoint({finishedAt:new Date().toISOString(),confirmationPolicy:'all model assessments remain unverified; no confirmed hierarchy overwritten'});
      await atomicJSON(new URL('validation/deepseek-hierarchy-latest.json',root),status);
      console.log(JSON.stringify(status));
    }
  }
} catch(error) {
  await checkpoint({status:'paused',reason:/^[A-Za-z0-9_]+$/.test(error.code||'')?error.code:'operation_failed'});
  console.error(JSON.stringify({status:status.status,reason:status.reason}));process.exitCode=1;
} finally {
  if(connection){if(locked&&!lost)await connection.query('SELECT pg_advisory_unlock(20261012,3)').catch(()=>{});connection.release(lost);}
  await pool.end();
}
