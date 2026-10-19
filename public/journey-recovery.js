// Persist choices, never catalogs, credentials, maps or generated plans. Writes
// are synchronous so an input does not depend on a timer or unload event.
const MAX_BYTES = 256 * 1024;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const text = (v, n = 150) => typeof v === 'string' ? v.slice(0, n) : '';
const answers = new Set(['interests','pace','transport','crowd','revisit','companion','walkingLimitKm','endBy','travelFocus','visitedNames','avoidPlaceNames']);
function normalize(value) {
  if (!value || typeof value !== 'object') throw Error('Invalid draft');
  if(Object.keys(value.pendingWishes || {}).length>2000)throw Error('Too many pending choices');
  const cities = (value.cities || []).slice(0, 5).map(c => ({
    ...Object.fromEntries(['id','name','country','province','timezone'].map(k => [k, text(c[k], 150)])),
    ...(Number.isFinite(c.lat) && Number.isFinite(c.lng) ? {lat:c.lat,lng:c.lng} : {}),
  }));
  const sessionId = value.session?.id || value.sessionId;
  const questions = (value.questions || []).slice(0, 32).map(q => ({
    id:text(q.id,80),title:text(q.title,500),type:q.type === 'multi' ? 'multi' : 'single',
    options:(q.options || []).slice(0,30).map(o => typeof o === 'string' ? text(o,150) : {
      value:typeof o.value === 'number' ? o.value : text(o.value,150),label:text(o.label,300),
    }),
  }));
  return {
    active:!!value.active, step:Math.max(0, Math.min(Number.isInteger(value.step) ? value.step : 0, sessionId ? 2+cities.length+questions.length : 2)),
    origin:{label:text(value.origin?.label),...(Number.isFinite(value.origin?.lat)&&Number.isFinite(value.origin?.lng)?{lat:value.origin.lat,lng:value.origin.lng}:{})},
    cities,start:text(value.start,10),end:text(value.end,10),
    sessionId:uuid.test(sessionId || '') ? sessionId : null,
    clientSessionId:uuid.test(value.clientSessionId || '') ? value.clientSessionId : null,
    selections:Object.fromEntries(cities.filter(c=>Object.hasOwn(value.selections || {},c.id)).map(c=>[c.id,[...new Set((value.selections[c.id] || []).filter(x=>typeof x==='string'&&x.length<=100))].slice(0,30)])),
    questions,adaptiveQuestions:!!value.adaptiveQuestions,
    answerKeys:(value.answerKeys || []).filter(k=>answers.has(k)).slice(0,20),
    answers:Object.fromEntries(Object.entries(value.answers || {}).filter(([k])=>answers.has(k)).map(([k,v])=>[k,Array.isArray(v)?v.filter(x=>typeof x==='string').map(x=>text(x,100)).slice(0,30):typeof v==='number'?v:text(v,150)])),
    pendingWishes:Object.fromEntries(Object.entries(value.pendingWishes || {}).filter(([k,v])=>k.length<=80&&typeof v==='boolean').slice(0,2000)),
    district:text(value.district),limit:Math.max(24,Math.min(300,Number(value.limit)||24)),
    inspiration:value.inspiration?.postId ? {postId:text(value.inspiration.postId,80),placeIds:(value.inspiration.placeIds || []).filter(x=>typeof x==='string').slice(0,60)} : null,
  };
}
export function createJourneyRecovery({storage,userId,now=Date.now}) {
  if (!userId) throw Error('An authenticated owner is required');
  const key='seatraces-journey-draft:v1:'+userId;
  return {
    key,
    read() {
      try {
        const raw=storage.getItem(key);
        if(!raw || raw.length>MAX_BYTES) return null;
        const record=JSON.parse(raw);
        if(record.schema!=='journey-draft/1' || record.owner!==userId) return null;
        return normalize(record.progress);
      } catch { return null; }
    },
    save(progress) {
      try {
        const raw=JSON.stringify({schema:'journey-draft/1',owner:userId,savedAt:now(),progress:normalize(progress)});
        if(new TextEncoder().encode(raw).length>MAX_BYTES) throw Error('Draft size limit');
        storage.setItem(key,raw);
        return true;
      } catch { return false; }
    },
    clear() { try {storage.removeItem(key);return true;} catch {return false;} },
  };
}

export function overlayPendingWishes(catalog,pending) {
  for(const group of catalog.clusters || []) for(const parent of group.members || []) {
    for(const p of [parent,...(parent.children || [])]) {
      if(Object.hasOwn(pending,p.id)) p.ownWanted=pending[p.id];
      p.wanted=Boolean(p.ownWanted);
    }
    parent.wanted=Boolean(parent.ownWanted || parent.children?.some(p=>p.wanted));
  }
  return catalog;
}
