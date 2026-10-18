import { explicitStyle } from "./memory.mjs";
const dayMs = 86400000;
const plus = (date, days) =>
  new Date(Date.parse(date + "T12:00:00Z") + days * dayMs)
    .toISOString()
    .slice(0, 10);
export function localDate(now = new Date(), timeZone = "Asia/Shanghai") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const number = (s) => {
  if (/^\d+$/.test(s)) return Number(s);
  const n = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (s === "十") return 10;
  if (s.includes("十")) {
    const [a, b] = s.split("十");
    return (n[a] || 1) * 10 + (n[b] || 0);
  }
  return n[s];
};
export function travelTiming(
  text,
  {
    now = new Date(),
    timeZone = "Asia/Shanghai",
    start,
    days,
    questionKey,
  } = {},
) {
  const result = {},
    dates = [],
    today = localDate(now, timeZone);
  for (const m of text.matchAll(
    /大后天|后天|明天|明早|明晚|明日|今天|今早|今晚|\d{4}[-年/.]\d{1,2}[-月/.]\d{1,2}日?/g,
  )) {
    const before = text.slice(Math.max(0, m.index - 10), m.index),
      after = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/(?:不是|不选|别选|不要|不在|不去)\s*$/.test(before)) continue;
    let value;
    if (/^\d/.test(m[0])) {
      const v = m[0].match(/(\d{4})[-年/.](\d{1,2})[-月/.](\d{1,2})/);
      value = `${v[1]}-${v[2].padStart(2, "0")}-${v[3].padStart(2, "0")}`;
      const time = Date.parse(value + "T12:00:00Z");
      if (
        !Number.isFinite(time) ||
        new Date(time).toISOString().slice(0, 10) !== value
      )
        return {
          invalid: true,
          conflict: {
            key: questionKey === "end" ? "end" : "start",
            text: "这个日期不存在，请重新选择有效日期。",
            options: [],
          },
        };
    } else
      value = plus(
        today,
        m[0] === "大后天"
          ? 3
          : m[0] === "后天"
            ? 2
            : m[0].startsWith("明")
              ? 1
              : 0,
      );
    dates.push({
      value,
      end:
        /^(?:\s|早上|上午|下午|晚上|日|号)*(?:回|返)/.test(after) ||
        /(?:回程|返回)(?:日期)?(?:是|在|改成)?$/.test(before),
      label: m[0],
    });
  }
  const correction = /(改成|改为|改到|改口|说错)/.test(text);
  if (dates.length === 1)
    result[dates[0].end ? "end" : questionKey === "end" ? "end" : "start"] =
      dates[0].value;
  else if (dates.length > 1) {
    const unique = [...new Set(dates.map((d) => d.value))];
    if (correction)
      result[questionKey === "end" ? "end" : "start"] = dates.at(-1).value;
    else if (
      unique.length > 1 &&
      (/或者|或是|还是|要么/.test(text) ||
        (dates.filter((d) => !d.end).length > 1 && !/到|至|~|～/.test(text)))
    ) {
      result.conflict = {
        key: questionKey === "end" ? "end" : "start",
        text: "出行日期还不确定，这次选哪一天？",
        options: unique,
      };
    } else {
      result.start = dates[0].value;
      result.end = dates.at(-1).value;
    }
  }
  const durations = [
    ...text.matchAll(/([一二两三四五六七八九十\d]{1,3})\s*天/g),
  ]
    .filter(
      (m) =>
        !/(提前|之后|以后|延后|推迟|每隔|每)$/.test(
          text.slice(Math.max(0, m.index - 3), m.index),
        ) && !/^[前后]/.test(text.slice(m.index + m[0].length)),
    )
    .map((m) => number(m[1]));
  const uniqueDays = [...new Set(durations)];
  if (uniqueDays.length > 1 && !correction)
    result.conflict = {
      key: "duration",
      text: "想玩几天？请选一个天数。",
      options: uniqueDays.filter((n) => n >= 1 && n <= 30),
    };
  else if (uniqueDays.length) {
    const n = uniqueDays.at(-1);
    if (n >= 1 && n <= 30) result.days = n;
    else
      result.conflict = {
        key: "end",
        text: "单次行程最多 30 天，请选择返回日期。",
        options: [],
      };
  }
  const duration = result.days || days,
    begin = result.start || start;
  if (begin && duration && (result.start || result.days) && !result.conflict) {
    const computed = plus(begin, duration - 1);
    if (result.end && result.end !== computed)
      result.conflict = {
        key: "end",
        text: "游玩天数与返回日期不一致，以哪个返回日期为准？",
        options: [result.end, computed],
      };
    else if (!result.end) result.end = computed;
  }
  return result;
}
export function tripPreferences(text) {
  // These conditions affect this trip only. Long-term memory still requires its
  // existing explicit preview/confirmation workflow.
  const result = {},
    choices = {};
  for (const clause of text
    .split(/[，。；,;！!?？]/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (
      /朋友|他喜欢|她喜欢|例如|假如|如果|不是|不要记|不想少|不要少/.test(clause)
    )
      continue;
    const values = explicitStyle("这次我" + clause);
    if (
      /(?:想看|想逛|喜欢|偏爱).{0,8}博物馆/.test(clause) &&
      !/(不想|不要|不喜欢).{0,5}博物馆/.test(clause)
    )
      values.interests = [...(values.interests || []), "人文"];
    for (const [k, v] of Object.entries(values)) {
      if (k === "interests")
        result[k] = [...new Set([...(result[k] || []), ...v])];
      else {
        if (result[k] && result[k] !== v) choices[k] = [result[k], v];
        result[k] = v;
      }
    }
  }
  // Two objectives in the same sentence need a priority, not last-match wins.
  if (/少走路/.test(text) && /少换乘/.test(text))
    choices.transport = ["fewWalking", "fewTransfers"];
  if(!/如果|假如|例如|比如/.test(text)){
    if(/(?:带|陪|和|跟)(?:着)?(?:父母|爸妈|爸爸妈妈)/.test(text)&&!/不(?:要)?(?:带|陪|和|跟)(?:着)?(?:父母|爸妈|爸爸妈妈)/.test(text))result.companion='parents';
    else if(/(?:带|和|跟)(?:着)?(?:孩子|小孩|宝宝)/.test(text)&&!/不(?:要)?(?:带|和|跟)(?:着)?(?:孩子|小孩|宝宝)/.test(text))result.companion='family';
    else if(/(?:我)?(?:自己|独自|一个人)(?:去|出发|旅行|玩)/.test(text))result.companion='solo';
    const maxWalk=text.match(/(?:每天|每日)?(?:步行|走路)(?:不超过|最多|控制在|上限)?\s*(\d+(?:\.\d+)?)\s*(?:公里|千米|km)/i);
    if(maxWalk){const n=Number(maxWalk[1]);if(n>=.5&&n<=30)result.walkingLimitKm=n;}
    const end=text.match(/(?:下午|晚上)?([一二三四五六七八九十\d]{1,2})(?:点|时)(?:前|之前)(?:结束|回|完成|收工)/);
    if(end){let h=number(end[1]);if(h<8)h+=12;if(h>=8&&h<=22)result.endBy=String(h).padStart(2,'0')+':00';}
    const visited=[...text.matchAll(/(?:以前|之前|曾经)?(?:已经|曾)?去过(?:了)?\s*([^，。；,;！!?？\s]{2,20})/g)].filter(m=>!/(?:没|未|不曾|没有)$/.test(text.slice(0,m.index))).map(m=>m[1]);
    if(visited.length)result.visitedNames=[...new Set(visited)].slice(0,30);
    const avoid=[...text.matchAll(/(?:不想去|不去|不要安排|别安排)\s*([^，。；,;！!?？\s]{2,20})/g)].map(m=>m[1]);
    if(avoid.length)result.avoidPlaceNames=[...new Set(avoid)].slice(0,30);
  }
  for (const k of Object.keys(choices)) delete result[k];
  return { values: result, conflicts: choices };
}
export function compoundTripRequest(text) {
  return (
    !/^(如果|假如|例如|比如)|不是要|不想去|不要去|别去/.test(text) &&
    /(我|帮我|给我|安排|规划|制定|制订|生成)/.test(text) &&
    /(?:去|到)[\p{L}·-]{2,15}/u.test(text) &&
    /(明天|明早|明晚|后天|今天|\d{4}[-年/.]|[一二两三四五六七八九十\d]+天|规划|安排|制订|制定|生成|我想去|我要去)/.test(
      text,
    )
  );
}
