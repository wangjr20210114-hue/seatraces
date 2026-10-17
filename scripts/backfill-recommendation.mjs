import {localDatabase} from './recommendation-local-db.mjs';
import {backfillItems,buildProfile} from '../server/recommendation/profiles.mjs';
const db=await localDatabase();
try{
 const items=await backfillItems(db.query);let profiles=0,last='00000000-0000-0000-0000-000000000000';
 for(;;){const users=(await db.query('SELECT id FROM users WHERE id>$1 ORDER BY id LIMIT 50',[last])).rows;if(!users.length)break;
  for(const u of users){await db.transaction(c=>buildProfile(c,u.id));profiles++;}last=users.at(-1).id;
 }console.log(JSON.stringify({items,profiles}));
}finally{await db.close();}
