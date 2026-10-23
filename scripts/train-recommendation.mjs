/* 训练并保存本地推荐模型。 */

import {localDatabase} from './recommendation-local-db.mjs';
import {trainRecommendations} from '../server/recommendation/training.mjs';
const db=await localDatabase();
try{console.log(JSON.stringify(await trainRecommendations({...db,scope:process.argv.includes('--real')?'real':'synthetic',activate:process.argv.includes('--activate')}),null,2));}finally{await db.close();}
