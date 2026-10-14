import { query } from '../db.mjs';
import { hierarchyPlaceHash } from '../domain/scenic-hierarchy.mjs';

export async function loadScenicHierarchy(points) {
  if (!points.length) return new Map();
  const hashes = new Map(points.map(p => [p.id, hierarchyPlaceHash(p)]));
  const {rows} = await query('SELECT place_id,input_hash,result FROM scenic_hierarchy_results WHERE place_id=ANY($1) AND review_after>now()', [[...hashes.keys()]]);
  return new Map(rows.filter(r => hashes.get(r.place_id) === r.input_hash).map(r => [r.place_id, r.result]));
}

export async function saveScenicHierarchy(place, result, connection) {
  const exec = connection ? connection.query.bind(connection) : query;
  await exec(`INSERT INTO scenic_hierarchy_results(place_id,input_hash,result,source_hash,review_after)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(place_id) DO UPDATE SET input_hash=excluded.input_hash,
    result=excluded.result,source_hash=excluded.source_hash,checked_at=now(),review_after=excluded.review_after`,
    [place.id, hierarchyPlaceHash(place), JSON.stringify(result), result.sourceHash, result.reviewAfter]);
}
