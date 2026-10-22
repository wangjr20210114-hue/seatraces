// Repeatable five-city cycle. No Amap calls; checkpoints prevent repeated model
// spending. Uncertain outcomes are completed investigations, not invented roots.
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import {localApiLimitsEnabled} from '../server/domain/api-limits.mjs';
import { hierarchyVersion, hierarchyPlaceHash, hashJSON, hierarchyInstruction, validateHierarchyProposal, estimateFinish } from '../server/domain/scenic-hierarchy.mjs';
import { atomicJSON, readJSON, collectEvidence, buildEvidenceJobs } from '../server/services/hierarchy-evidence.mjs';

const root = new URL('../', import.meta.url), dir = new URL('.runtime/scenic-hierarchy/', root);
const args = new Set(process.argv.slice(2));
if ([...args].some(a => !['--run','--llm','--status','--stop','--skip-extract'].includes(a)) || !['--run','--status','--stop'].some(a => args.has(a))) throw Error('Use --run [--llm] [--skip-extract], --status, or --stop');
await mkdir(dir, {recursive:true});
if (args.has('--status')) {console.log(JSON.stringify(await readJSON(new URL('status.json', dir)), null, 2)); process.exit(0);}
if (args.has('--stop')) {await atomicJSON(new URL('stop.json',dir), {requestedAt:new Date().toISOString()}); console.log('Stop requested; worker checkpoints before its next paid call.'); process.exit(0);}
dotenv.config({path:new URL('.env',root),quiet:true});
const local = await readJSON(new URL('.runtime/local.json',root));
if (local) process.env.DATABASE_URL = `postgresql://seatraces:${encodeURIComponent(local.password)}@127.0.0.1:${local.port}/seatraces`;
process.env.AMAP_PARENT_LOOKUP_ENABLED = 'false';
const {pool, query, migrate} = await import('../server/db.mjs');
const {loadParentChecks} = await import('../server/repositories/scenic-parents.mjs');
const status = {algorithm:hierarchyVersion, startedAt:new Date().toISOString(), status:'running', phase:'preparing', commercialAmapCalls:0, modelCallsThisRun:0};
let connection, locked=false, databaseLost=false;
async function checkpoint(extra={}) {
  Object.assign(status, extra, {updatedAt:new Date().toISOString(), elapsedSeconds:Math.round((Date.now()-Date.parse(status.startedAt))/1000)});
  await atomicJSON(new URL('status.json',dir),status);
}
async function stopRequested() {return databaseLost || Boolean(await readJSON(new URL('stop.json',dir)));}
async function saveRows(points, rows) {
  const byId = new Map(points.map(p=>[p.id,p]));
  for (let offset=0;offset<rows.length;offset+=250) {
    const batch = rows.slice(offset,offset+250).map(r=>({place_id:r.placeId,input_hash:hierarchyPlaceHash(byId.get(r.placeId)),result:r,source_hash:r.sourceHash,review_after:r.reviewAfter}));
    await query(`INSERT INTO scenic_hierarchy_results(place_id,input_hash,result,source_hash,review_after)
      SELECT place_id,input_hash,result,source_hash,review_after FROM jsonb_to_recordset($1::jsonb)
      AS r(place_id text,input_hash text,result jsonb,source_hash text,review_after timestamptz)
      ON CONFLICT(place_id) DO UPDATE SET input_hash=excluded.input_hash,result=excluded.result,
      source_hash=excluded.source_hash,checked_at=now(),review_after=excluded.review_after`, [JSON.stringify(batch)]);
  }
}
try {
  connection=await pool.connect(); connection.on('error',()=>{databaseLost=true;});
  locked=(await connection.query('SELECT pg_try_advisory_lock(20261012,2) AS locked')).rows[0].locked;
  if (!locked) {console.log('A hierarchy worker is already running.'); process.exitCode=1;}
  else {
    await unlink(new URL('stop.json',dir)).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await migrate();
    await checkpoint();
    // Quota warnings must not be consumed by concurrent web background lookups.
    if ((await query('SELECT count(*)::int n FROM pg_locks WHERE locktype=\'advisory\' AND classid=20261012 AND objid=1 AND granted')).rows[0].n) throw Object.assign(Error('Amap worker active'),{code:'amap_worker_active'});
    if (!args.has('--skip-extract')) {
      await checkpoint({phase:'extract_osm'});
      const python=process.env.OSM_PYTHON || (process.platform==='win32' ? 'python' : 'python3');
      await new Promise((resolve,reject)=>{
        const p=spawn(python,[fileURLToPath(new URL('scripts/osm/scenic_geometry.py',root))],
          {cwd:fileURLToPath(root),windowsHide:true,stdio:['ignore','inherit','inherit'],env:{...process.env,PYTHONPATH:fileURLToPath(new URL('.runtime/osm-deps',root))}});
        p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(Object.assign(Error('extraction failed'),{code:'extraction_failed'})));
      });
    }
    const data=await readJSON(new URL('geometry-result.json',dir));
    if (!data || data.algorithm!=='osm-scenic-geometry/1') throw Object.assign(Error('geometry missing'),{code:'geometry_missing'});
    const points=data.points.map(p=>({...p,mainlandCityVerified:true})), byId=new Map(points.map(p=>[p.id,p]));
    const geometryRows=Object.entries(data.geometries).map(([place_id,geometry_geojson])=>({place_id,geometry_geojson}));
    for(let offset=0;offset<geometryRows.length;offset+=250) {
      await query(`INSERT INTO scenic_area_geometries(place_id,geometry_geojson,source_hash,source_timestamp)
        SELECT place_id,geometry_geojson,$2,$3 FROM jsonb_to_recordset($1::jsonb) AS r(place_id text,geometry_geojson jsonb)
        ON CONFLICT(place_id) DO UPDATE SET geometry_geojson=excluded.geometry_geojson,source_hash=excluded.source_hash,
        source_timestamp=excluded.source_timestamp,updated_at=now() WHERE scenic_area_geometries.source_hash<>excluded.source_hash`,
        [JSON.stringify(geometryRows.slice(offset,offset+250)),data.source.sha256,data.source.downloaded_at]);
    }
    const checks=await loadParentChecks(points);
    const previous=(await query('SELECT * FROM scenic_hierarchy_results WHERE place_id=ANY($1)',[points.map(p=>p.id)])).rows;
    if (previous.length) await atomicJSON(new URL('backups/'+Date.now()+'.json',dir),previous);
    const prior=new Map(previous.map(r=>[r.place_id,r.result]));
    const sourceTime=Date.parse(data.source.downloaded_at), reviewAfter=new Date(sourceTime+30*86400_000).toISOString();
    const rows=data.results.map(row=>({...row, provider:'osm', algorithm:hierarchyVersion, sourceHash:data.fingerprint,
      checkedAt:new Date().toISOString(), reviewAfter,
      evidence:{sourceUrl:byId.get(row.placeId).source_url || 'https://www.openstreetmap.org/'+row.placeId.slice(4),
        parentSourceUrl:row.parentId?'https://www.openstreetmap.org/'+row.parentId.slice(4):null,
        pbfSha256:data.source.sha256,sourceSnapshotAt:data.sourceSnapshotAt,method:row.method,reviewStatus:row.status==='child'?'source_supported':'pending'},
      proposals:prior.get(row.placeId)?.sourceHash===data.fingerprint?prior.get(row.placeId).proposals || []:[],
      modelAssessment:prior.get(row.placeId)?.sourceHash===data.fingerprint?prior.get(row.placeId).modelAssessment || null:null}));
    await saveRows(points,rows);
    const count=predicate=>rows.filter(predicate).length;
    const confirmed=checks.size?[...checks.values()].filter(r=>['root','child'].includes(r.status)).length:0;
    const noProvider=r=>!['root','child'].includes(checks.get(r.placeId)?.status);
    const coverage={...data.summary,providerConfirmed:confirmed,additionalOsmChildren:count(r=>noProvider(r)&&r.status==='child'),
      remainingSpatialCandidates:count(r=>noProvider(r)&&r.status==='spatial_candidate'),
      remainingUnknown:count(r=>noProvider(r)&&['unknown','conflict'].includes(r.status)),
      scopedWebsiteTags:points.filter(p=>p.rawTags?.website || p.rawTags?.['contact:website']).length};
    const discovery=points.filter(p=>p.rawTags?.website || p.rawTags?.['contact:website']).map(p=>({id:p.id,name:p.name,city:p.city,url:p.rawTags.website || p.rawTags['contact:website'],trust:'unreviewed_osm_link'}));
    await atomicJSON(new URL('source-discovery.json',dir),discovery);
    // Deterministic stratified audit across all five cities, including positives,
    // spatial-only, unknown, and provider-known records. No precision is claimed.
    const sample=[];
    for(const cityId of data.cities) {
      const cityRows=rows.filter(r=>byId.get(r.placeId).cityId===cityId);
      const selected=new Map();
      const buckets=[cityRows.filter(r=>r.status==='child'),cityRows.filter(r=>r.status==='spatial_candidate'),cityRows.filter(r=>['root','child'].includes(checks.get(r.placeId)?.status)),cityRows.filter(r=>r.status==='unknown'),cityRows];
      for(let pass=0;selected.size<Math.min(20,cityRows.length);pass++) {
        for(const bucket of buckets) {const row=bucket[pass];if(row)selected.set(row.placeId,row);if(selected.size===20)break;}
      }
      sample.push(...[...selected.values()].map(r=>({...r,providerResult:checks.get(r.placeId)||null})));
    }
    await atomicJSON(new URL('validation/scenic-hierarchy-sample.json',root),{at:new Date().toISOString(),sampleSize:sample.length,reviewStatus:'sample_for_review_not_accuracy_estimate',items:sample});
    await checkpoint({phase:'offline_complete',fingerprint:data.fingerprint,coverage});
    const summary={at:new Date().toISOString(),algorithm:hierarchyVersion,coverage,cities:data.cities.map(id=>({id,name:points.find(p=>p.cityId===id)?.city,
      statuses:rows.filter(r=>byId.get(r.placeId).cityId===id).reduce((a,r)=>(a[r.status]=(a[r.status]||0)+1,a),{})})),
      notes:['spatial candidates are not published as semantic children','LLM proposals require semantic review','existing Amap results remain unchanged']};
    await atomicJSON(new URL('validation/scenic-hierarchy-latest.json',root),summary);
    if(args.has('--llm') && !await stopRequested()) {
      await checkpoint({phase:'collect_evidence'});
      const registry=await readJSON(new URL('data/editorial/hierarchy-sources.json',root));
      const collected=await collectEvidence(registry,new URL('evidence/',dir));
      await atomicJSON(new URL('evidence-report.json',dir),{sources:collected.evidence.map(({text,...r})=>r),errors:collected.errors});
      const jobs=buildEvidenceJobs(data,checks,collected.evidence);
      await atomicJSON(new URL('jobs.json',dir),jobs);
      const {request}=await import('../server/integrations/http.mjs');
      const {createDeepseekClient}=await import('../server/integrations/deepseek.mjs');
      let usage;
      const llm=createDeepseekClient({requestJSON:async(...a)=>{const r=await request(...a);usage=r.usage;return r;}});
      const model=process.env.DEEPSEEK_MODEL || 'deepseek-flash';
      const ledgerPath=new URL('ledger-'+data.fingerprint.slice(0,20)+'.json',dir);
      const ledger=await readJSON(ledgerPath) || {reservedCny:0,calls:0,estimatedCny:0};
      const limitsEnabled=localApiLimitsEnabled();
      const budget=limitsEnabled?Number(process.env.HIERARCHY_MODEL_BUDGET_CNY || 5):null;
      if(limitsEnabled&&(!Number.isFinite(budget)||budget<0||budget>200))throw Object.assign(Error('budget invalid'),{code:'invalid_batch_budget'});
      let completed=0,rejectedJobs=0,failedJobs=0;const modelStarted=new Date().toISOString();
      const activeHashes=new Set(jobs.map(input=>hashJSON({version:hierarchyVersion,instruction:hierarchyInstruction,model,
        input:{...input,evidence:input.evidence.map(({retrievedAt,...e})=>e)}})));
      for(const row of rows)row.proposals=(row.proposals||[]).filter(p=>activeHashes.has(p.jobHash));
      await checkpoint({phase:'model_extract',jobsTotal:jobs.length,jobsCompleted:0,modelBudgetCny:budget,ledger});
      for(const input of jobs) {
        if(await stopRequested()){status.status='paused';status.reason='stop_requested';break;}
        // Hash stable content, not fetch time: fetching the same page tomorrow
        // should not cause another model payment.
        const stable={...input,evidence:input.evidence.map(({retrievedAt,...e})=>e)};
        const hash=hashJSON({version:hierarchyVersion,instruction:hierarchyInstruction,model,input:stable});
        const path=new URL('jobs/'+hash+'.json',dir);
        let job=await readJSON(path);
        if(!job) {
          if(model!=='deepseek-flash') {status.status='paused';status.reason='model_price_not_configured';break;}
          const reserve=Math.max(.1,(Buffer.byteLength(JSON.stringify(input)+hierarchyInstruction)+2000)*2/1e6+1800*8/1e6);
          if(limitsEnabled&&ledger.reservedCny+reserve>budget) {status.status='paused';status.reason='batch_model_budget';break;}
          ledger.reservedCny+=reserve;ledger.calls++;
          await atomicJSON(ledgerPath,ledger);
          job={hash,status:'attempting',startedAt:new Date().toISOString(),reservedCny:reserve};
          await atomicJSON(path,job);
          try {
            usage=null;job.output=await llm(hierarchyInstruction,input,{maxTokens:1800});
            job.usage=usage;job.status='received';job.elapsedMs=Date.now()-Date.parse(job.startedAt);
            job.estimatedCny=((usage?.prompt_tokens || 0)*2+(usage?.completion_tokens || 0)*8)/1e6;
            ledger.estimatedCny+=job.estimatedCny;status.modelCallsThisRun++;
            await atomicJSON(path,job);await atomicJSON(ledgerPath,ledger);
          } catch(error) {
            job.status='failed_no_automatic_paid_retry';job.errorCode=error.code || 'model_request_failed';
            await atomicJSON(path,job);
            if(error.status===429 || error.status===503) {status.status='paused';status.reason=job.errorCode;break;}
          }
        }
        if(job.output) {
          try {
            const validated=validateHierarchyProposal(job.output,input);
            job.validation='literal_and_id_checks_passed';job.reviewStatus='pending';
            for(const r of validated.relations) {
              const target=rows.find(row=>row.placeId===r.childId);
              target.proposals=(target.proposals||[]).filter(p=>p.jobHash!==hash);
              target.proposals.push({...r,jobHash:hash,model});
            }
            job.validated=validated;
          } catch(error) {job.validation='rejected';job.validationReason=/^[a-z_]+$/.test(error.message)?error.message:'validation_failed';}
          await atomicJSON(path,job);
        }
        if(job.validation==='rejected')rejectedJobs++;
        if(job.status!=='received')failedJobs++;
        completed++;
        await checkpoint({jobsCompleted:completed,ledger,estimate:estimateFinish(modelStarted,completed,jobs.length)});
      }
      await saveRows(points,rows);
      summary.model={jobs:jobs.length,completed,rejectedJobs,failedJobs,callsThisRun:status.modelCallsThisRun,...ledger,
        proposedRelations:rows.reduce((n,r)=>n+(r.proposals||[]).length,0),sourceFetchErrors:collected.errors.length};
      await atomicJSON(new URL('validation/scenic-hierarchy-latest.json',root),summary);
    }
    // Explicit semantic reviews are pinned to the exact model job and source
    // bytes. New evidence cannot inherit an old review automatically.
    const reviews=await readJSON(new URL('data/editorial/hierarchy-reviews.json',root)) || {decisions:[]};
    for(const decision of reviews.decisions) {
      const row=rows.find(r=>r.placeId===decision.childId);
      const proposal=row?.proposals?.find(p=>p.jobHash===decision.jobHash && p.parentId===decision.parentId && p.evidence.sha256===decision.sourceSha256);
      if(!proposal)continue;
      proposal.evidence.reviewStatus=decision.status;
      proposal.review={reviewedAt:decision.reviewedAt,reason:decision.reason};
      if(decision.status==='accepted' && byId.has(decision.parentId)
          && Date.parse(decision.reviewedAt)<=Date.now() && Date.now()-Date.parse(decision.reviewedAt)<90*86400_000
          && row.candidates.some(c=>c.parentId===decision.parentId && !c.boundaryTouch)) {
        Object.assign(row,{status:'child',parentId:decision.parentId,provider:'official',method:'official_evidence_review',
          evidence:{...proposal.evidence,reviewStatus:'accepted',reviewedAt:decision.reviewedAt},
          reviewAfter:new Date(Date.parse(decision.reviewedAt)+90*86400_000).toISOString()});
      }
    }
    await saveRows(points,rows);
    summary.reviewedChildren=rows.filter(r=>r.method==='official_evidence_review').length;
    summary.newConfirmedChildren=rows.filter(r=>r.status==='child' && !['root','child'].includes(checks.get(r.placeId)?.status)).length;
    const stillUnresolved=r=>r.status!=='child' && !['root','child'].includes(checks.get(r.placeId)?.status);
    summary.finalCoverage={total:points.length,providerConfirmed:confirmed,additionalConfirmed:summary.newConfirmedChildren,
      spatialPending:rows.filter(r=>stillUnresolved(r)&&r.status==='spatial_candidate').length,
      unknown:rows.filter(r=>stillUnresolved(r)&&['unknown','conflict'].includes(r.status)).length,
      unresolved:rows.filter(stillUnresolved).length};
    await atomicJSON(new URL('validation/scenic-hierarchy-latest.json',root),summary);
    if(status.status!=='paused') status.status=await stopRequested()?'paused':'complete_with_unresolved';
    await checkpoint({phase:'finished',finishedAt:new Date().toISOString(),model:summary.model || null,
      reviewedChildren:summary.reviewedChildren,newConfirmedChildren:summary.newConfirmedChildren});
    console.log(JSON.stringify(status));
  }
} catch(error) {
  await checkpoint({status:'paused',reason:/^[a-zA-Z0-9_]+$/.test(error.code||'')?error.code:'operation_failed'});
  console.error(JSON.stringify({status:status.status,reason:status.reason}));process.exitCode=1;
} finally {
  if(connection) {if(locked&&!databaseLost)await connection.query('SELECT pg_advisory_unlock(20261012,2)').catch(()=>{});connection.release(databaseLost);}
  await pool.end();
}
