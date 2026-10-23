/* 读取和保存景区主体地点的核验结果。 */

import { query } from "../db.mjs";
import { parentInputHash } from "../domain/amap-parent.mjs";
import { mainlandEligible } from "../../public/coordinates.js";

export async function loadParentChecks(points) {
  if (!points.length) return new Map();
  const input = new Map(points.map((p) => [p.id, parentInputHash(p)]));
  const byId = new Map(points.map((p) => [p.id, p]));
  const { rows } = await query(
    "SELECT place_id,input_hash,result FROM scenic_parent_checks WHERE place_id=ANY($1) AND expires_at>now()",
    [[...input.keys()]],
  );
  return new Map(
    rows
      .filter(
        (r) =>
          input.get(r.place_id) === r.input_hash &&
          !(
            r.result.status === "unsupported" &&
            mainlandEligible(byId.get(r.place_id))
          ),
      )
      .map((r) => [r.place_id, r.result]),
  );
}
export async function saveParentCheck(point, result) {
  const days = ["root", "child", "unsupported"].includes(result.status)
    ? 14
    : result.status === "failed"
      ? 10 / 1440
      : 1;
  await query(
    `INSERT INTO scenic_parent_checks(place_id,input_hash,result,expires_at) VALUES($1,$2,$3,now()+$4::double precision*interval '1 day')
    ON CONFLICT(place_id) DO UPDATE SET input_hash=excluded.input_hash,result=excluded.result,checked_at=now(),expires_at=excluded.expires_at`,
    [point.id, parentInputHash(point), JSON.stringify(result), days],
  );
}
