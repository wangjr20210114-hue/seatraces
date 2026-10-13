import { embedNames, embeddingModel } from "../integrations/embedding.mjs";
let busy = false;
export async function semanticRanking(query, items) {
  if (!query.q || !items.length) return { items, status: "not_needed" };
  if (busy) return { items, status: "busy_fallback" };
  busy = true;
  const started = performance.now();
  const work = (async () => {
    const bounded = items.slice(0, 60),
      scores = [];
    for (let offset = 0; offset < bounded.length; offset += 25) {
      if (performance.now() - started > 4500)
        throw Error("bounded inference deadline");
      const batch = bounded.slice(offset, offset + 25);
      const vectors = await embedNames([
        `${query.city || ""} ${query.q}`.trim(),
        ...batch.map((p) =>
          `${p.location.city || query.city || ""} ${p.name}`
            .trim()
            .slice(0, 180),
        ),
      ]);
      scores.push(
        ...batch.map((p, i) => ({
          p,
          cosine: vectors[0].reduce((s, v, j) => s + v * vectors[i + 1][j], 0),
        })),
      );
    }
    scores.sort((a, b) => b.cosine - a.cosine);
    return {
      status: "ready",
      model: embeddingModel,
      elapsedMs: Math.round(performance.now() - started),
      items: [
        ...scores.map(({ p, cosine }, rank) => ({
          ...p,
          semantic: {
            cosine: Number(cosine.toFixed(6)),
            rank,
            model: embeddingModel.name,
          },
        })),
        ...items.slice(60),
      ],
    };
  })().finally(() => {
    busy = false;
  });
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("embedding timeout")), 5000);
      }),
    ]);
  } catch {
    return { items, status: "unavailable_fallback" };
  } finally {
    clearTimeout(timer);
  }
}
