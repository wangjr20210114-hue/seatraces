/* 导入 GeoNames 城市与行政区数据。 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import pg from "pg";
const cfg = process.env.DATABASE_URL
  ? null
  : JSON.parse(await readFile(".runtime/local.json", "utf8"));
const client = new pg.Client({
  connectionString:
    process.env.DATABASE_URL ||
    `postgresql://seatraces:${cfg.password}@127.0.0.1:${cfg.port}/seatraces`,
});
await client.connect();
const inputDir = existsSync("data/geonames/cities15000.txt")
  ? "data/geonames"
  : ".runtime/imports";
const admin = new Map(
  (await readFile(inputDir + "/admin1CodesASCII.txt", "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((x) => {
      const a = x.split("\t");
      return [a[0], a[1]];
    }),
);
const provinceNames = {
  "01": "安徽",
  "02": "浙江",
  "03": "江西",
  "04": "江苏",
  "05": "吉林",
  "06": "青海",
  "07": "福建",
  "08": "黑龙江",
  "09": "河南",
  10: "河北",
  11: "湖南",
  12: "湖北",
  13: "新疆",
  14: "西藏",
  15: "甘肃",
  16: "广西",
  18: "贵州",
  19: "辽宁",
  20: "内蒙古",
  21: "宁夏",
  22: "北京",
  23: "上海",
  24: "山西",
  25: "山东",
  26: "陕西",
  28: "天津",
  29: "云南",
  30: "广东",
  31: "海南",
  32: "四川",
  33: "重庆",
};
let n = 0,
  china = 0;
await client.query("BEGIN");
try {
  for await (const line of createInterface({
    input: createReadStream(inputDir + "/cities15000.txt"),
    crlfDelay: Infinity,
  })) {
    const a = line.split("\t");
    if (a.length < 19) continue;
    const aliases = [...new Set([a[1], a[2], ...a[3].split(",")])].filter(
      Boolean,
    );
    const zh = aliases.find((x) => /^[\u4e00-\u9fff]{2,12}$/.test(x));
    const name = zh || a[1],
      country = a[8],
      province =
        country === "CN"
          ? provinceNames[a[10]] || admin.get(country + "." + a[10]) || a[10]
          : admin.get(country + "." + a[10]) || a[10];
    await client.query(
      `INSERT INTO places(id,name,aliases,category,country,province,city,lat,lng,timezone,source,license,source_url,data_status,search_text) VALUES($1,$2,$3,'city',$4,$5,$2,$6,$7,$8,'GeoNames','CC-BY-4.0',$9,'reference',$10) ON CONFLICT(id) DO UPDATE SET name=excluded.name,aliases=excluded.aliases,province=excluded.province,search_text=excluded.search_text,updated_at=now()`,
      [
        "gn-" + a[0],
        name,
        aliases,
        country,
        province,
        Number(a[4]),
        Number(a[5]),
        a[17] || "UTC",
        "https://www.geonames.org/" + a[0],
        aliases.join(" ") + " " + province,
      ],
    );
    n++;
    if (country === "CN") china++;
    if (n % 5000 === 0) console.log("Imported cities: " + n);
  }
  await client.query("INSERT INTO import_jobs VALUES($1,$2,$3,$4,now())", [
    randomUUID(),
    "GeoNames cities15000 CC BY 4.0",
    n,
    "completed",
  ]);
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      imported: n,
      china,
      source: "GeoNames cities15000",
      note: "Cities and populated places, NOT attraction coverage",
    }),
  );
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
