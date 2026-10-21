import { officialOpening } from "./official-opening.mjs";
const visitCategory = (category) =>
  ["attraction", "heritage", "nature", "leisure"].includes(category);
export const interests = [
  "人文",
  "自然",
  "艺术",
  "美食",
  "园林",
  "建筑",
  "夜景",
  "安静",
  "亲子",
  "街区",
];
export const questionBank = [
  {
    id: "interests",
    title: "这次旅行，什么最让你心动？",
    subtitle: "可以多选，让沿途更像你。",
    type: "multi",
    options: interests,
  },
  {
    id: "pace",
    title: "你喜欢怎样的旅行节奏？",
    subtitle: "给旅途留白，或把每一天过得充实。",
    type: "single",
    options: [
      { value: "relaxed", label: "慢慢来 · 多留些休息" },
      { value: "balanced", label: "刚刚好 · 逛逛停停" },
      { value: "full", label: "充实一点 · 多走一程" },
    ],
  },
  {
    id: "transport",
    title: "在城市里，你更偏爱怎样出行？",
    subtitle: "后续会提供时间、换乘和步行的不同选择。",
    type: "single",
    options: [
      { value: "balanced", label: "综合推荐" },
      { value: "fewTransfers", label: "尽量少换乘" },
      { value: "fewWalking", label: "尽量少走路" },
    ],
  },
];
export const distance = (a, b) => {
  const r = Math.PI / 180,
    dl = (b.lat - a.lat) * r,
    dg = (b.lng - a.lng) * r,
    s =
      Math.sin(dl / 2) ** 2 +
      Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dg / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
};
export function datesBetween(start, end) {
  const a = Date.parse(start + "T00:00:00Z"),
    b = Date.parse(end + "T00:00:00Z");
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    new Date(a).toISOString().slice(0, 10) !== start ||
    new Date(b).toISOString().slice(0, 10) !== end ||
    b < a ||
    b - a > 29 * 86400000
  )
    throw Object.assign(
      new Error("请选择有效日期，结束日期不能早于开始日期，最长 30 天。"),
      { status: 400 },
    );
  return Array.from({ length: Math.round((b - a) / 86400000) + 1 }, (_, i) =>
    new Date(a + i * 86400000).toISOString().slice(0, 10),
  );
}
const minutes = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
const time = (n) =>
  `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
export function schedule(stops, date, pace = "balanced", anchor = null) {
  let clock = 9 * 60,
    last = anchor;
  const planned = [],
    warnings = [];
  for (const p of stops) {
    if (!visitCategory(p.category)) continue;
    const travel = last
      ? Math.max(
          10,
          Math.ceil(
            ((distance(last, p) * 1.35) / (pace === "relaxed" ? 3 : 4)) * 60,
          ),
        )
      : 0;
    const official = officialOpening(p, date);
    const confirmed = official?.canConstrainSchedule;
    const hours = official
      ? confirmed && official.intervals[0]
        ? {
            open: official.intervals[0].start,
            close: official.intervals[0].end,
          }
        : null
      : p.hours;
    const knownHours = Boolean(hours?.open && hours?.close);
    const open = knownHours ? minutes(hours.open) : 0,
      close = knownHours ? minutes(hours.close) : Infinity,
      lastEntry = hours?.lastEntry ? minutes(hours.lastEntry) : close;
    if (
      (confirmed && official.dayState === "closed") ||
      hours?.closedWeekdays?.includes(new Date(date + "T12:00:00Z").getUTCDay())
    ) {
      warnings.push(`${p.name} 当日闭园，未排入。`);
      continue;
    }
    const arrive = Math.max(clock + travel, open);
    const duration = Number(p.duration_min) > 0 ? Number(p.duration_min) : 90;
    const leave = arrive + duration;
    if (arrive > lastEntry || leave > close || leave > 19 * 60) {
      warnings.push(`${p.name} 超出可用时段，未排入。`);
      continue;
    }
    planned.push({
      ...p,
      arrive: time(arrive),
      leave: time(leave),
      travelMin: travel,
      duration_min: duration,
      timingStatus: knownHours ? "reference_schedule" : "opening_unconfirmed",
      durationSource:
        Number(p.duration_min) > 0 ? "place_record" : "planning_default",
      locked: !!p.locked,
    });
    clock = leave + 25;
    last = p;
  }
  return { stops: planned, warnings };
}
export function ordered(points, start) {
  const todo = [...points],
    out = [];
  let last = start || todo[0];
  while (todo.length) {
    todo.sort((a, b) => distance(last, a) - distance(last, b));
    last = todo.shift();
    out.push(last);
  } // 2-opt reduces geographical detours; no claim of optimal road routing.
  for (let k = 0; k < 3; k++)
    for (let i = 0; i < out.length - 2; i++)
      for (let j = i + 2; j < out.length - 1; j++) {
        if (
          distance(out[i], out[i + 1]) + distance(out[j], out[j + 1]) >
          distance(out[i], out[j]) + distance(out[i + 1], out[j + 1])
        )
          out.splice(i + 1, j - i, ...out.slice(i + 1, j + 1).reverse());
      }
  return out;
}
export function makePlan(req, cities, places) {
  const dates = datesBetween(req.start, req.end);
  if (cities.length > dates.length)
    throw Object.assign(
      new Error("每天至少留给一座城市，请延长日期或减少目的地。"),
      { status: 400 },
    );
  const used = new Set(),
    warnings = [],
    days = [],
    n = { relaxed: 2, balanced: 3, full: 4 }[req.pace] || 3;
  for (let d = 0; d < dates.length; d++) {
    const ci = Math.min(
        cities.length - 1,
        Math.floor((d * cities.length) / dates.length),
      ),
      city = cities[ci],
      anchor =
        places.find(
          (p) =>
            p.id === req.anchorPlaceId &&
            p.city === city.name &&
            ["hotel", "hostel", "accommodation"].includes(p.category),
        ) || null;
    const candidates = places.filter(
      (p) =>
        p.city === city.name && visitCategory(p.category) && !used.has(p.id),
    );
    const score = (p) =>
      (p.tags || []).filter((t) => req.interests.includes(t)).length * 3;
    candidates.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const first = candidates[0];
    const cluster = first
      ? candidates
          .sort(
            (a, b) =>
              distance(first, a) -
              score(a) * 0.2 -
              (distance(first, b) - score(b) * 0.2),
          )
          .slice(0, n)
      : [];
    const day = schedule(ordered(cluster, anchor), dates[d], req.pace, anchor);
    day.stops.forEach((p) => used.add(p.id));
    warnings.push(...day.warnings);
    if (!day.stops.length)
      warnings.push(
        `${city.name} ${dates[d]} 暂无足够已收录景点，请补充数据或手动添加。`,
      );
    days.push({
      index: d,
      date: dates[d],
      city: city.name,
      cityId: city.id,
      timezone: city.timezone,
      anchor,
      stops: day.stops,
    });
  }
  const transfers = cities.slice(1).map((c, i) => ({
    from: cities[i],
    to: c,
    status: "needs_live_query",
    note: "跨城当天暂按目的地 09:00 开始演示，须根据实际到达时间重排。",
  }));
  if (transfers.length)
    warnings.push(
      "跨城交通尚未锁定；当前目的地日程未扣除跨城耗时，请查询车次/航班后核实。",
    );
  warnings.push(
    "行程仅安排游玩点；当前路线耗时为距离估算，需以地图路线核实。未确认开放时间的停留属于草案。",
  );
  return {
    days,
    cities,
    transfers,
    warnings: [...new Set(warnings)],
    source: "local-heuristic",
    routeStatus: "estimated",
    generatedAt: new Date().toISOString(),
    interests: req.interests,
    pace: req.pace,
  };
}
export function applyEdit(plan, operation, places) {
  const p = structuredClone(plan),
    day = p.days[operation.day];
  if (!day) throw Object.assign(new Error("无效日期"), { status: 400 });
  const i = day.stops.findIndex((x) => x.id === operation.placeId);
  if (operation.type === "lock") {
    if (i < 0) throw new Error("地点不存在");
    day.stops[i].locked = !day.stops[i].locked;
    return p;
  }
  if (i >= 0 && day.stops[i].locked)
    throw Object.assign(new Error("请先解锁这个地点"), { status: 409 });
  if (operation.type === "remove") {
    if (i < 0) throw new Error("地点不存在");
    day.stops.splice(i, 1);
  }
  if (operation.type === "replace" || operation.type === "add") {
    const q = places.find(
      (x) =>
        x.id === operation.newPlaceId &&
        visitCategory(x.category) &&
        x.city === day.city,
    );
    if (!q)
      throw Object.assign(new Error("请选择当天城市内的景点"), { status: 400 });
    if (p.days.some((d) => d.stops.some((x) => x.id === q.id)))
      throw Object.assign(new Error("行程已有这个景点"), { status: 400 });
    if (operation.type === "replace") {
      if (i < 0) throw new Error("地点不存在");
      day.stops[i] = q;
    } else day.stops.push(q);
  }
  if (operation.type === "move") {
    if (i < 0) throw new Error("地点不存在");
    const target = operation.to;
    if (!Number.isInteger(target) || target < 0 || target >= day.stops.length)
      throw Object.assign(new Error("超出当日行程范围"), { status: 400 });
    if (target === i) return p;
    if (day.stops.slice(Math.min(i, target), Math.max(i, target) + 1).some(stop => stop.locked))
      throw Object.assign(new Error("移动会改变已锁定地点的位置，请先解锁"), { status: 409 });
    const [moved] = day.stops.splice(i, 1);
    day.stops.splice(target, 0, moved);
  }
  const computed = schedule(day.stops, day.date, p.pace, day.anchor);
  if (computed.stops.length !== day.stops.length)
    throw Object.assign(new Error(computed.warnings.join(" ")), {
      status: 409,
    });
  day.stops = computed.stops;
  return p;
}
