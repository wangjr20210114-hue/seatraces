// A query must never report zero simply because raw events moved to an archive.
async function available(query){return (await query("SELECT to_regclass(format('%I.event_archives',current_schema())) IS NOT NULL available")).rows[0].available;}
export async function requireRawCoverage(query,start,end,{stream=null,userId=null}={}){
  if(!await available(query))return;
  if((await query(`SELECT 1 FROM event_archives WHERE restored_at IS NULL AND first_at<$2 AND last_at>=$1
    AND ($3::text IS NULL OR stream=$3) AND ($4::text IS NULL OR user_index ? $4) LIMIT 1`,[start,end,stream,userId])).rowCount)
    throw Object.assign(Error('该日期范围包含已归档明细，请查看长期汇总或恢复归档后查询'),{status:409,code:'events_archived'});
}
export async function archivedUserStats(query,userId){
  if(!await available(query))return {count:0,last_at:null,last_activity_at:null};
  return (await query(`SELECT coalesce(sum((user_index->$1->>'count')::bigint),0)::int count,
    max((user_index->$1->>'lastAt')::timestamptz) last_at,
    max((user_index->$1->>'lastActivityAt')::timestamptz) last_activity_at
    FROM event_archives WHERE stream='operation' AND restored_at IS NULL AND user_index ? $1`,[userId])).rows[0];
}
export async function archivedEvent(query,id){
  if(!await available(query))return null;
  return (await query("SELECT id FROM event_archives WHERE restored_at IS NULL AND stream='operation' AND event_ids @> $1::text[] LIMIT 1",[[id]])).rows[0]?.id||null;
}
export async function archivedRequests(query,userId,requestIds){
  if(!requestIds.length||!await available(query))return false;
  return !!(await query(`SELECT 1 FROM event_archives WHERE restored_at IS NULL AND stream='product'
    AND user_index ? $1 AND request_ids && $2::uuid[] LIMIT 1`,[userId,requestIds])).rowCount;
}
export const latestTime=(a,b)=>!a?b:!b?a:new Date(a)>new Date(b)?a:b;
