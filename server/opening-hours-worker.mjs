// Interpret a local calendar day in a UTC process. These Date values are wall
// clocks, not real UTC instants. No host timezone or DST may alter their fields.
import OpeningHours from 'opening_hours';
let input='';
for await (const chunk of process.stdin){input+=chunk;if(input.length>10000)process.exit(1);}
try{
  if(new Date('2026-01-01T00:00:00Z').getTimezoneOffset()!==0)throw Error('UTC worker required');
  const {expression,date}=JSON.parse(input),start=new Date(date+'T00:00:00Z'),end=new Date(+start+86400000);
  const rules=new OpeningHours(expression,null,{tag_key:'opening_hours',locale:'en'});
  const intervals=rules.getOpenIntervals(start,end).map(([from,to,unknown,comment])=>({
    start:unknown?null:from.toISOString().slice(11,16),end:unknown?null:+to===+end?'24:00':to.toISOString().slice(11,16),
    unknown:Boolean(unknown),comment:comment||null,
  }));
  if(intervals.length>96)throw Error('Too many intervals');
  process.stdout.write(JSON.stringify({status:'parsed',normalized:rules.prettifyValue(),warnings:rules.getWarnings().slice(0,8),
    dayState:intervals.some(x=>x.unknown)?'uncertain':intervals.length?'open_intervals':'closed',intervals}));
}catch{
  process.stdout.write(JSON.stringify({status:'unparseable',dayState:'unknown',intervals:[],message:'原始开放时间无法可靠解析，请查看来源或联系地点确认。'}));
}
