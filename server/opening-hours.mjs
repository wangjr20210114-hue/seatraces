/* 查询指定日期的开放时间，管理解析任务。 */

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { placeTimeZone } from "../public/travel-time.js";
import { officialOpening } from "./official-opening.mjs";
const worker = fileURLToPath(
  new URL("./opening-hours-worker.mjs", import.meta.url),
);
let running = 0;
export function validateOpeningDate(date) {
  const instant = new Date(String(date) + "T00:00:00Z");
  if (
    !/^20\d{2}-\d{2}-\d{2}$/.test(date || "") ||
    !Number.isFinite(+instant) ||
    instant.toISOString().slice(0, 10) !== date
  )
    throw Object.assign(Error("请选择 2000–2099 年间有效的当地日期"), {
      status: 400,
    });
  return date;
}
export async function openingOnDate(place, date) {
  validateOpeningDate(date);
  const raw =
    typeof place.opening_hours === "string" ? place.opening_hours.trim() : "";
  const editorial = place.facts?.openingHours;
  const base = {
    placeId: place.id,
    date,
    timeZone: placeTimeZone(place) || null,
    raw: raw || null,
    source: "OpenStreetMap",
    sourceUrl: place.source_url || null,
    sourceTimestamp: place.source_timestamp || null,
    cacheStatus: place.cacheStatus || "live",
    cachedAt: place.cachedAt || null,
    referenceOnly: true,
    interpretation: "place_local_calendar_day",
    editorialNote:
      editorial?.value && editorial.source !== "OpenStreetMap"
        ? editorial
        : null,
    notice:
      "按来源规则推算的当地日历时段，未经现场核实；不是实时营业状态。最后入场、预约与临时调整须另行确认。",
  };
  const official = officialOpening(place, date);
  if (official) return { ...base, ...official };
  if (!raw)
    return {
      ...base,
      status: "missing",
      dayState: "unknown",
      intervals: [],
      message: "此地点没有开放时段记录。",
    };
  if (raw.length > 2000)
    return {
      ...base,
      status: "unparseable",
      dayState: "unknown",
      intervals: [],
      message: "开放规则过长，请查看原始来源。",
    };
  const selectors = raw.replace(/"(?:[^"\\]|\\.)*"/g, "");
  if (/\b(?:PH|SH|sunrise|sunset|dawn|dusk|easter)\b/i.test(selectors))
    return {
      ...base,
      status: "needs_context",
      dayState: "unknown",
      intervals: [],
      message:
        "规则涉及节假日、学校假期或天文时刻，缺少经过核实的当地资料，请查看原文确认。",
    };
  if (running >= 2)
    throw Object.assign(Error("开放时段解析繁忙，请稍后重试"), { status: 429 });
  running++;
  try {
    const result = await new Promise((resolve, reject) => {
      const env = {
        TZ: "UTC",
        ...(process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      };
      const child = execFile(
        process.execPath,
        [worker],
        { env, timeout: 2500, maxBuffer: 65536, windowsHide: true },
        (error, stdout) => {
          if (error)
            return reject(
              Object.assign(Error("开放时段解析超时或不可用，请查看原始规则"), {
                status: 503,
              }),
            );
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(
              Object.assign(Error("开放时段解析结果无效"), { status: 503 }),
            );
          }
        },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ expression: raw, date }));
    });
    return { ...base, ...result };
  } finally {
    running--;
  }
}
