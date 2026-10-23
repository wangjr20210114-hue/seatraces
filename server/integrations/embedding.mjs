/* 加载嵌入模型，将地点名称转换为语义向量。 */

import { fileURLToPath } from "node:url";

export const embeddingModel = {
  name: "Xenova/bge-small-zh-v1.5",
  revision: "75c43b069aac4d136ba6bc1122f995fedcfd2781",
  dtype: "q8",
  dimensions: 512,
  pooling: "cls",
};
let extractor;
export async function embedNames(texts) {
  if (
    !Array.isArray(texts) ||
    texts.length > 26 ||
    texts.some((t) => typeof t !== "string" || !t.trim() || t.length > 180)
  )
    throw new Error("Embedding input outside bounded name batch");
  if (!extractor)
    extractor = (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.localModelPath = fileURLToPath(
        new URL("../../.runtime/models/", import.meta.url),
      );
      return pipeline("feature-extraction", "bge-small-zh-v1.5", {
        dtype: "q8",
        device: "cpu",
        local_files_only: true,
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      });
    })().catch((error) => {
      extractor = null;
      throw error;
    });
  const model = await extractor;
  const output = await model(texts, {
    pooling: "cls",
    normalize: true,
    truncation: true,
    max_length: 96,
  });
  return output.tolist();
}
export async function disposeEmbedding() {
  if (extractor) {
    await (await extractor).dispose();
    extractor = null;
  }
}
