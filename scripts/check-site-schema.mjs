/* 检查 OSM site 层级表结构和查询能力。 */

import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
const local=JSON.parse(await readFile(new URL('../.runtime/local.json',import.meta.url),'utf8'));
const client=new pg.Client({host:'127.0.0.1',port:local.port,user:'seatraces',password:local.password,database:'seatraces',connectionTimeoutMillis:4000});
const schema='site_smoke_'+Date.now();
try{
 await client.connect();
 await client.query('BEGIN');
 await client.query(`CREATE SCHEMA ${schema}`);
 await client.query(`CREATE TABLE ${schema}.current_poi(id text PRIMARY KEY,name text,category text,subcategory text)`);
 await client.query(`INSERT INTO ${schema}.current_poi VALUES ('osm:node/1','Cafe','food','cafe'),('osm:node/2','Hotel','accommodation','hotel'),('osm:node/3','Unlinked','service','pharmacy')`);
 const sql=(await readFile(new URL('./osm/site_schema.sql',import.meta.url),'utf8')).replaceAll('osm.',schema+'.');
 await client.query(sql);
 await client.query(`INSERT INTO ${schema}.site_builds(build_id,algorithm,sources,status) VALUES('fixture','test','[]','complete')`);
 await client.query(`INSERT INTO ${schema}.site_objects(build_id,id,name,category,subcategory,is_site,catalog_present,tags,availability) VALUES
 ('fixture','osm:relation/100','Park','leisure','park',true,false,'{}','source_object'),
 ('fixture','osm:node/1','Cafe','food','cafe',false,true,'{}','catalog'),
 ('fixture','osm:node/2','Hotel','accommodation','hotel',false,true,'{}','catalog')`);
 await client.query(`INSERT INTO ${schema}.site_edges VALUES('fixture','osm:relation/100','osm:node/1',ARRAY[''],'source_reported'),('fixture','osm:relation/100','osm:node/2',ARRAY[''],'source_reported')`);
 await client.query(`INSERT INTO ${schema}.site_object_summary VALUES
 ('fixture','osm:relation/100',ARRAY[]::text[],2,'{"food":1,"accommodation":1}','no_site_membership_recorded'),
 ('fixture','osm:node/1',ARRAY['osm:relation/100'],0,'{}','source_reported'),
 ('fixture','osm:node/2',ARRAY['osm:relation/100'],0,'{}','source_reported')`);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${schema}.current_site_edges`)).rows[0].n,0);
 await client.query(`INSERT INTO ${schema}.site_active VALUES(true,'fixture')`);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${schema}.current_site_edges`)).rows[0].n,2);
 const rows=(await client.query(`SELECT * FROM ${schema}.current_poi_hierarchy ORDER BY id`)).rows;
 assert.equal(rows.length,3);
 assert.equal(rows[0].category,'food');
 assert.equal(rows[1].category,'accommodation');
 assert.equal(rows[0].site_parent_id,'osm:relation/100');
 assert.equal(rows[2].site_membership_status,'no_site_membership_recorded');
 await client.query(sql);
 assert.equal((await client.query(`SELECT count(*)::int AS n FROM ${schema}.current_site_edges`)).rows[0].n,2);
 console.log(JSON.stringify({passed:true,checks:['atomic publication','all categories preserved','supplemental parent','unlinked places retained','idempotent migration'],rolledBack:true}));
}catch(e){console.error('Site schema check failed: '+e.message);process.exitCode=1;}
finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
