// One in-flight page per view. New filters invalidate earlier responses, and
// the rendered IDs are supplied only when starting another recommendation pool.
export function createFeedPager({ api, onChange, context=()=>({}) }) {
  let generation = 0, dead = false,interestRevision=0;
  let state = { scope:'recommended', q:'', items:[], cursor:null, busy:false, error:'', exhausted:false };
  const emit = (change={}) => { if (!dead) onChange({ ...state }, change); };
  async function loadMore() {
    if (dead || state.busy || state.exhausted) return;
    const current = generation;
    const interest=interestRevision,city=String(context()?.city||'').slice(0,100),cityQuery=city?{city}:{};
    state.busy = true; state.error = ''; emit();
    try {
      const fresh = state.items.length > 0 && !state.cursor;
      const result = fresh && state.scope === 'recommended'
        ? await api('/api/social/feed', { scope:state.scope, q:state.q, limit:12,...cityQuery, exclude:state.items.map(p=>p.id) })
        : await api('/api/social/feed?' + new URLSearchParams({ scope:state.scope, q:state.q, limit:12,...cityQuery, ...(state.cursor?{cursor:state.cursor}:{}) }));
      if (dead || generation !== current) return;
      const seen = new Set(state.items.map(p=>p.id));
      const added = result.items.filter(p=>{ if(seen.has(p.id))return false;seen.add(p.id);return true; }).slice(0,600-state.items.length).map(p=>({...p,requestId:result.requestId}));
      state.items.push(...added); state.cursor = interest===interestRevision?result.nextCursor:null;
      state.exhausted = state.items.length >= 600 || (state.scope !== 'recommended' && !state.cursor) || (!added.length && !state.cursor);
      emit({ added });
    } catch (e) {
      if (dead || generation !== current) return;
      state.error = e.message || '暂时无法加载';
      if (e.status === 410) state.cursor = null;
    } finally {
      if (!dead && generation === current) { state.busy = false; emit(); }
    }
  }
  return {
    interestChanged(){if(dead||state.scope!=='recommended')return;interestRevision++;state.cursor=null;if(state.items.length<600)state.exhausted=false;emit();},
    reset({ scope='recommended', q='' }={}) {
      generation++; state = { scope, q, items:[], cursor:null, busy:false, error:'', exhausted:false };
      emit({ reset:true }); return loadMore();
    },
    loadMore,
    dispose() { dead = true; generation++; },
  };
}
