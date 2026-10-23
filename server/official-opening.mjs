/* 从已核验的地点资料中计算开放时间。 */

export function reviewedFact(fact, date, now = new Date()) {
  if (
    !fact ||
    fact.source === "OpenStreetMap" ||
    fact.evidence?.reviewStatus !== "accepted"
  )
    return null;
  const e = fact.evidence;
  const due = Date.parse(e.reviewAfter || "");
  const visit = date || now.toISOString().slice(0, 10);
  const outside =
    (e.validFrom && visit < e.validFrom.slice(0, 10)) ||
    (e.validThrough && visit > e.validThrough.slice(0, 10));
  return {
    fact,
    usable:
      fact.status !== "needs_review" &&
      fact.value != null &&
      (!e.reviewAfter || (Number.isFinite(due) && +now < due)) &&
      !outside,
  };
}
const clean = (value) =>
  String(value).normalize("NFKC").replace(/\s+/g, "").replaceAll("；", ";");
const hm = (value) => {
  const [h, m] = value.split(":").map(Number);
  return h >= 0 && h < 24 && m >= 0 && m < 60
    ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
    : null;
};
const inMonths = (month, first, last) =>
  first <= last
    ? month >= first && month <= last
    : month >= first || month <= last;
export function officialOpening(place, date, now = new Date()) {
  const choice = reviewedFact(place.facts?.openingHours, date, now);
  if (!choice) return null;
  const fact = choice.fact;
  const base = {
    raw: fact.value,
    source: fact.source,
    sourceUrl: fact.sourceUrl,
    sourceTimestamp: fact.sourceTimestamp,
    evidence: fact.evidence,
    editorialNote: null,
    intervals: [],
    regularIntervals: [],
    dayState: "unknown",
    referenceOnly: true,
    ruleVersion: "official-hours/1",
    canConstrainSchedule: false,
  };
  if (!choice.usable)
    return {
      ...base,
      status: "needs_review",
      raw: null,
      message: "该官方资料需复核，暂不用于日期计算。",
    };
  if (typeof fact.value !== "string" || fact.value.length > 2000)
    return {
      ...base,
      status: "unparseable",
      message: "请查看官方原文中的开放安排。",
    };
  const text = clean(fact.value),
    month = Number(date.slice(5, 7)),
    weekday = new Date(date + "T12:00:00Z").getUTCDay();
  const clauses = text.split(";");
  let interval = null,
    exceptions = [],
    matched = 0;
  for (const clause of clauses) {
    const seasonal =
      /^(\d{1,2})-(?:次年)?(\d{1,2})月(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(
        clause,
      );
    if (
      seasonal &&
      [+seasonal[1], +seasonal[2]].every((x) => x >= 1 && x <= 12) &&
      hm(seasonal[3]) &&
      hm(seasonal[4]) &&
      hm(seasonal[3]) < hm(seasonal[4])
    ) {
      matched++;
      if (inMonths(month, +seasonal[1], +seasonal[2]))
        interval = {
          start: hm(seasonal[3]),
          end: hm(seasonal[4]),
          unknown: false,
        };
    } else if (
      clause === "清明、五一、中秋、十一期间延迟半小时闭园,18:00闭园" ||
      clause === "清明、五一、中秋、十一期间延迟半小时闭园，18:00闭园"
    )
      exceptions.push(clause);
    else {
      matched = 0;
      break;
    }
  }
  let regular = interval ? [interval] : null;
  if (!matched) {
    const weekly =
      /^每星期二至星期日(\d{1,2}:\d{2})-(\d{1,2}:\d{2}),每星期一闭馆\(国家法定节假日除外\),夜间开放时间另行公布$/.exec(
        text,
      );
    if (
      !weekly ||
      !hm(weekly[1]) ||
      !hm(weekly[2]) ||
      hm(weekly[1]) >= hm(weekly[2])
    )
      return {
        ...base,
        status: "unparseable",
        message: "官方说明未匹配现有规则，请查看原文；未回退到旧 OSM 时段。",
      };
    regular =
      weekday === 1
        ? []
        : [{ start: hm(weekly[1]), end: hm(weekly[2]), unknown: false }];
    exceptions = ["国家法定节假日、夜间开放以另行公告为准"];
  }
  if (!regular)
    return {
      ...base,
      status: "unparseable",
      message: "官方规则没有覆盖所选月份。",
    };
  return {
    ...base,
    status: exceptions.length ? "needs_context" : "parsed",
    dayState: exceptions.length
      ? "uncertain"
      : regular.length
        ? "open"
        : "closed",
    intervals: exceptions.length ? [] : regular,
    regularIntervals: regular,
    canConstrainSchedule: !exceptions.length,
    exceptions,
    message: exceptions.length
      ? "以下为官方常规时段；尚未核对该日节假日与临时公告，不能保证该日实际开放。"
      : null,
  };
}
