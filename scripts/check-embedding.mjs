import { writeFile } from "node:fs/promises";
import {
  embedNames,
  disposeEmbedding,
  embeddingModel,
} from "../server/integrations/embedding.mjs";
const texts = [
  "衢州孔庙",
  "孔氏南宗家庙",
  "衢州古城文化旅游区孔氏南宗家庙",
  "衢州水亭门历史文化街区",
  "衢州孔庙站公交站",
  "曲阜孔庙",
];
const start = performance.now();
try {
  const vectors = await embedNames(texts);
  const report = {
    at: new Date().toISOString(),
    model: embeddingModel,
    elapsedMs: Math.round(performance.now() - start),
    query: texts[0],
    scores: texts
      .slice(1)
      .map((name, i) => ({
        name,
        cosine: Number(
          vectors[0]
            .reduce((n, x, j) => n + x * vectors[i + 1][j], 0)
            .toFixed(6),
        ),
        geographicAndCategoryEligible: i < 3,
      }))
      .sort((a, b) => b.cosine - a.cosine),
    note: "Public fixed names. Bus stop and out-of-city temple must be filtered before ranking. Cosine is not identity confidence.",
  };
  await writeFile(
    new URL("../validation/embedding-20261011.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await disposeEmbedding();
}
