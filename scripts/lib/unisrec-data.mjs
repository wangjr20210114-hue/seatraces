import {combine, digest, profileText, week} from './offline-semantic.mjs';

// An offline, bounded export. Every history item must have finished its label
// window before the current exposure. No current or future outcome is a feature.
export function sequenceInputs(samples, itemVectors, queryVectors, split) {
  if (!samples.length || samples.length > 5000) throw Error('Expected 1..5000 samples');
  const posts = [], profiles = [], postIndex = new Map(), profileIndex = new Map();
  const historicalVectors = new Map(), past = new Map();
  const partitions = new Map();
  for (const kind of ['train','validation','test']) for (const row of split[kind]) {
    if (partitions.has(row)) throw Error('Overlapping partitions');
    partitions.set(row, kind);
  }
  const rows = [...samples].sort((a,b) => a.at-b.at).map(row => {
    if (!itemVectors.has(row.postId) || !queryVectors.has(profileText(row.user))) throw Error('Missing cached semantic vector');
    const version = digest(row.item);
    if (historicalVectors.has(row.postId) && historicalVectors.get(row.postId) !== version) throw Error('Historical item features changed; use versioned embeddings');
    historicalVectors.set(row.postId, version);
    if (!postIndex.has(row.postId)) {
      postIndex.set(row.postId, posts.length);
      posts.push({id:row.postId,features:combine(row.item,itemVectors.get(row.postId))});
    }
    const profileKey = digest(row.user);
    if (!profileIndex.has(profileKey)) {
      profileIndex.set(profileKey,profiles.length);
      profiles.push({features:combine(row.user,queryVectors.get(profileText(row.user)))});
    }
    const previous = past.get(row.userId) || [];
    const eligible = previous.filter(p => p.label === 1 && p.at+week < row.at && row.at-p.at <= 30*86400000).slice(-20);
    const result = {userId:row.userId,postId:row.postId,post:postIndex.get(row.postId),profile:profileIndex.get(profileKey),
      at:row.at,label:row.label,weight:row.weight,partition:partitions.get(row) || 'embargo',
      history:eligible.map(p=>postIndex.get(p.postId)),historyWindowEnds:eligible.map(p=>p.at+week)};
    previous.push(row); past.set(row.userId,previous); return result;
  });
  return {posts,profiles,rows};
}
