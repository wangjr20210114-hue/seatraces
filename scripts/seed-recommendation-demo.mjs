/* 写入推荐演示使用的示例数据。 */

import {readFile} from 'node:fs/promises';
import {localDatabase} from './recommendation-local-db.mjs';
import {seedDemo,removeDemo} from '../server/recommendation/demo.mjs';
const db=await localDatabase();
try{
 await db.transaction(async c=>{for(const f of ['auth-schema.sql','social/schema.sql','social/style-schema.sql','recommendation/schema.sql'])await c.query(await readFile(new URL('../server/'+f,import.meta.url),'utf8'));});
 const remove=process.argv.indexOf('--remove');
 const r=remove<0?await seedDemo(db):await removeDemo({...db,batchId:process.argv[remove+1]});
 const {userIds,...summary}=r;console.log(JSON.stringify(summary,null,2));
}finally{await db.close();}
