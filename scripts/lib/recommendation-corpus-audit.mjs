import {createHash} from 'node:crypto';
import {featuresFromPlaces,interestMap} from '../../server/social/features.mjs';

const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stopsOf=post=>(post.snapshot?.days||[]).flatMap(day=>day.stops||[]);
const routeIdentity=post=>stopsOf(post).map(p=>[p.id,p.name,p.category]);
// The seed's wall clock only changes the opening date and timestamps. Compare
// the remaining presentation, route and topic data before attributing its rules.
export function matchesGeneratedPost(post,generated){
  return post.id===generated.id&&post.title===generated.title&&
    JSON.stringify(post.tags)===JSON.stringify(generated.tags)&&
    JSON.stringify(routeIdentity(post))===JSON.stringify(routeIdentity(generated))&&
    post.body.replace(/^\d{1,2}月\d{1,2}日/,'')===generated.body.replace(/^\d{1,2}月\d{1,2}日/,'');
}

export function auditCorpus(posts,{routes=[],generatorContexts=new Map()}={}){
  if(!Array.isArray(posts)||posts.length>1000||new Set(posts.map(p=>p.id)).size!==posts.length)throw Error('Corpus must contain at most 1000 unique posts');
  const report={algorithm:'local-corpus-audit/1',total:posts.length,withRoute:0,withoutRoute:0,
    routeVariants:0,distinctTagSets:0,stops:0,stopsWithTraits:0,topicEvidence:{},
    generation:{verifiedPosts:0,unverifiedPosts:0,uniqueSourceRoute:0,missingSelectionTrigger:0,examples:[]},
    sourceDigest:fingerprint(posts.map(p=>[p.id,p.title,p.body,p.tags,p.snapshot])),
    caveat:'Missing name/category/trait evidence is not proof that a topic is false. A lost keyword proves a selection/truncation mismatch, not real-world unsuitability.',
    automaticRelabeling:false,databaseWrites:0,activationAllowed:false};
  const variants=new Set(),tagSets=new Set();
  for(const post of posts){
    const stops=stopsOf(post),tags=Array.isArray(post.tags)?post.tags:[];
    if(stops.length){report.withRoute++;variants.add(fingerprint(routeIdentity(post)));}else report.withoutRoute++;
    tagSets.add(JSON.stringify([...new Set(tags)].sort()));report.stops+=stops.length;
    report.stopsWithTraits+=stops.filter(p=>p.traits&&Object.keys(p.traits).length).length;
    const values=featuresFromPlaces(stops,[]);
    for(const tag of new Set(tags)){
      if(!interestMap[tag])continue;
      const row=report.topicEvidence[tag]||={posts:0,withRoute:0,routeEvidence:0,noRecognizedRouteEvidence:0,examples:[]};
      row.posts++;if(!stops.length)continue;row.withRoute++;
      if(interestMap[tag].some(key=>values[key]>0))row.routeEvidence++;
      else {row.noRecognizedRouteEvidence++;if(row.examples.length<3)row.examples.push({id:post.id,title:post.title,route:stops.map(p=>p.name)});}
    }
    const context=generatorContexts.get(post.id);
    if(!context||!matchesGeneratedPost(post,context.generated)){report.generation.unverifiedPosts++;continue;}
    report.generation.verifiedPosts++;
    if(!stops.length)continue;
    const candidates=routes.filter(r=>r.stops.length>=stops.length&&stops.every((p,i)=>p.id===r.stops[i].id&&p.name===r.stops[i].name));
    if(candidates.length!==1)continue;
    report.generation.uniqueSourceRoute++;
    const keywords=context.keywords||[],matches=p=>keywords.some(k=>String(p.name).includes(k));
    if(candidates[0].stops.some(matches)&&!stops.some(matches)){
      report.generation.missingSelectionTrigger++;
      if(report.generation.examples.length<8)report.generation.examples.push({id:post.id,title:post.title,style:context.generated.style,
        sourceRoute:candidates[0].id,selectedStops:stops.map(p=>p.name),omittedMatchingStops:candidates[0].stops.slice(stops.length).filter(matches).map(p=>p.name)});
    }
  }
  report.routeVariants=variants.size;report.distinctTagSets=tagSets.size;return report;
}
