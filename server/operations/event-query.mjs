import {z} from 'zod';
const fail=message=>Object.assign(Error(message),{status:400});
export const logColumns=['created_at','username','kind','action','status','duration_ms','request_id','resource_id'];
export const logFilterSchema=z.object({
  from:z.iso.date().optional(),to:z.iso.date().optional(),userId:z.uuid().optional(),
  kind:z.enum(['request','navigation','admin','system']).optional(),
  actor:z.string().trim().min(1).max(80).optional(),action:z.string().trim().min(1).max(120).optional(),
  outcome:z.enum(['all','success','failure']).default('all'),
  minDuration:z.coerce.number().int().min(0).max(2147483647).optional(),
  requestId:z.uuid().optional(),resourceId:z.string().trim().min(1).max(200).optional(),
  sort:z.enum(['created_at','duration_ms']).default('created_at'),order:z.enum(['asc','desc']).default('desc'),
});
export function eventFilters(input,now=new Date()){
  const v=logFilterSchema.parse(input);
  const end=v.to?new Date(v.to+'T00:00:00+08:00').getTime()+86400000:now.getTime()+1;
  const start=v.from?new Date(v.from+'T00:00:00+08:00').getTime():end-7*86400000;
  if(end<=start||end-start>31*86400000)throw fail('请选择不超过 31 天的有效日期范围');
  return [new Date(start).toISOString(),new Date(end).toISOString(),v.userId||null,v.kind||null];
}
export function eventQuery(input,now){
  const filters=logFilterSchema.parse(input),values=eventFilters(filters,now);
  const clauses=['e.created_at >= $1','e.created_at < $2','($3::uuid IS NULL OR e.user_id=$3)','($4::text IS NULL OR e.kind=$4)'];
  const bind=value=>{values.push(value);return '$'+values.length;};
  const contains=value=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%';
  if(filters.actor){const p=bind(contains(filters.actor));clauses.push(`(u.username ILIKE ${p} OR u.nickname ILIKE ${p})`);}
  if(filters.action)clauses.push(`e.action ILIKE ${bind(contains(filters.action))}`);
  if(filters.outcome==='failure')clauses.push("(e.status>=400 OR e.kind='system')");
  if(filters.outcome==='success')clauses.push("(e.status BETWEEN 200 AND 399 AND e.kind<>'system')");
  if(filters.minDuration!==undefined)clauses.push(`e.duration_ms>=${bind(filters.minDuration)}`);
  if(filters.requestId)clauses.push(`e.request_id=${bind(filters.requestId)}`);
  if(filters.resourceId)clauses.push(`e.resource_id=${bind(filters.resourceId)}`);
  return {filters,values,where:clauses.join(' AND '),order:`e.${filters.sort} ${filters.order} NULLS LAST,e.id ${filters.order}`};
}
