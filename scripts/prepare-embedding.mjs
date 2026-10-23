/* 下载并校验地点匹配使用的嵌入模型文件。 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { embeddingModel } from "../server/integrations/embedding.mjs";
const files = {
  "config.json":
    "d4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f",
  "tokenizer.json":
    "48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26",
  "tokenizer_config.json":
    "e6f3b96db926a37d4039995fbf5ad17de158dfb8f6343d607e4dbaad18d75f5a",
  "special_tokens_map.json":
    "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
  "onnx/model_quantized.onnx":
    "15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc",
};
const root = new URL("../.runtime/models/bge-small-zh-v1.5/", import.meta.url),
  records = [];
await mkdir(new URL("onnx/", root), { recursive: true });
for (const [name, expected] of Object.entries(files)) {
  let bytes;
  try {
    bytes = await readFile(new URL(name, root));
  } catch {}
  if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected) {
    const response = await fetch(
      `https://huggingface.co/${embeddingModel.name}/resolve/${embeddingModel.revision}/${name}`,
      { signal: AbortSignal.timeout(120000) },
    );
    if (!response.ok) throw Error("Model download failed: " + name);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== expected)
      throw Error("Model hash mismatch: " + name);
    await writeFile(new URL(name, root), bytes);
  }
  records.push({ name, bytes: bytes.length, sha256: expected });
}
await writeFile(
  new URL("manifest.json", root),
  JSON.stringify({ ...embeddingModel, files: records }, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    model: embeddingModel.name,
    verifiedFiles: records.length,
    totalBytes: records.reduce((n, x) => n + x.bytes, 0),
  }),
);
