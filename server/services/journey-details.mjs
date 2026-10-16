import { catalogMember } from "../repositories/journey-candidates.mjs";
export async function journeyPlaceDetail({
  query,
  resolvePlace,
  sessionId,
  userId,
  placeId,
}) {
  const member = await catalogMember({
    query,
    sessionId,
    userId,
    placeId,
    includeChildren: true,
  });
  if (!member)
    throw Object.assign(Error("地点不在候选范围内"), { status: 404 });
  const item = await resolvePlace(member.id);
  if (!item) throw Object.assign(Error("地点资料暂不可用"), { status: 503 });
  const row = (
    await query(
      "SELECT result,checked_at,review_after FROM scenic_hierarchy_results WHERE place_id=$1",
      [member.id],
    )
  ).rows[0];
  return {
    item,
    hierarchyInference: row?.result || null,
    inferenceCheckedAt: row?.checked_at || null,
    inferenceReviewAfter: row?.review_after || null,
    sourceIds: [member.id, ...(member.possibleDuplicateIds || [])],
    fetchedAt: new Date().toISOString(),
  };
}
