import { readFileSync } from "node:fs";
import { test } from "./fixtures.mjs";
export const catalog = JSON.parse(
  readFileSync(new URL("./catalog.json", import.meta.url), "utf8"),
);
export const cases = catalog.modules.flatMap((m) =>
  m.cases.map((c) => ({ ...c, sheet: m.sheet })),
);
export function check(id, run, coverage = "full", note = "") {
  const c = cases.find((c) => c.id === id);
  if (!c) throw Error("Unknown Excel case " + id);
  test(
    `${id} ${c.title} @${id.split("-")[0]}`,
    {
      annotation: [
        { type: "case", description: id },
        { type: "coverage", description: coverage },
        {
          type: "scope",
          description:
            note || "本地隔离库，真实页面与业务接口；第三方服务未启用",
        },
      ],
    },
    run,
  );
}
