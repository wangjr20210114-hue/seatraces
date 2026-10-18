import {rebuildStyle} from '../social/style-store.mjs';
import {buildProfile} from './profiles.mjs';
// Refresh only the authenticated user whose evidence changed. The dirty row
// lock serializes this with the existing worker; all existing bounds still apply.
export async function ensureCurrentProfile(transaction,userId){
  return transaction(async c=>{
    const row=(await c.query('SELECT version FROM style_dirty_users WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
    if(!row)return false;
    await rebuildStyle(c,userId);await buildProfile(c,userId);
    await c.query('DELETE FROM style_dirty_users WHERE user_id=$1 AND version=$2',[userId,row.version]);return true;
  });
}
