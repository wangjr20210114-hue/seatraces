import test from 'node:test';
import assert from 'node:assert/strict';
import {siteQuery} from '../server/contracts/catalog.mjs';
import {createOsmClient} from '../server/integrations/osm.mjs';

test('site queries bound pagination and reject ambiguous IDs or categories',()=>{
  assert.equal(siteQuery.parse({id:'osm:relation/1'}).limit,50);
  for(const input of [
    {id:['osm:relation/1','osm:relation/2']},
    {id:'osm:relation/1',limit:'201'},
    {id:'osm:relation/1',category:'scenic'},
    {id:'osm:relation/1',after:'https://example.com'},
  ]) assert.equal(siteQuery.safeParse(input).success,false);
});

test('site transport retains multiple parents and supplemental containers',async()=>{
  const payload={item:{id:'osm:relation/1',catalogPresent:false},parents:[{id:'osm:relation/2'},{id:'osm:relation/3'}],children:[],nextCursor:null};
  const request=createOsmClient({env:{OSM_SERVICE_URL:'http://127.0.0.1:8791'},fetchImpl:async(url)=>{
    assert.equal(url.pathname,'/site');
    assert.equal(url.searchParams.get('id'),'osm:relation/1');
    return {ok:true,json:async()=>payload};
  }});
  assert.deepEqual(await request('/site',{id:'osm:relation/1'}),payload);
  await assert.rejects(request('/write'),error=>error.status===400);
});
