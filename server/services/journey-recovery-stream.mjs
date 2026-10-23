/* 将已保存的城市选择分批写入恢复响应。 */

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { withSavedCityRows } from "../repositories/journey-snapshot.mjs";
import { applyWishes } from "../domain/scenic-entities.mjs";

export async function sendSavedCitySelection({
  res, transaction, sessionId, userId, cityId, wishes, restoreHeader,
}) {
  try {
    return await withSavedCityRows(
      { transaction, sessionId, userId, cityId },
      async (savedHeader, rows) => {
        const { clusters: _clusters, ...header } = await restoreHeader(savedHeader);
        async function* chunks() {
          yield JSON.stringify(header).slice(0, -1) + ',"clusters":[';
          let groupOpen = false, memberCount = 0;
          for await (const row of rows) {
            if (row.kind === "group") {
              if (groupOpen) yield "]},";
              yield JSON.stringify(row.data).slice(0, -1) + ',"members":[';
              groupOpen = true;
              memberCount = 0;
            } else {
              yield (memberCount++ ? "," : "") + JSON.stringify(applyWishes(row.data, wishes));
            }
          }
          if (groupOpen) yield "]}";
          yield "]}";
        }
        res.status(200).type("json");
        res.setHeader("Cache-Control", "no-store");
        await pipeline(Readable.from(chunks()), res);
      },
    );
  } catch (err) {
    if (!res.headersSent && !res.destroyed) throw err;
    res.destroy();
    if (err.code !== "ERR_STREAM_PREMATURE_CLOSE")
      console.error("Questionnaire recovery stream failed", err.status || 500);
    return true;
  }
}
