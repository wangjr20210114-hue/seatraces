/* 按标识查询本地地点记录。 */

import { query } from "../db.mjs";
export async function findLocalPlace(id) {
  return (await query("SELECT * FROM places WHERE id=$1", [id])).rows[0];
}
