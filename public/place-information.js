/* 展示地点事实、资料来源及信息状态。 */

export const factNames = {
  access: "访问限制",
  openingHours: "开放时段",
  lastEntry: "最后入园",
  fee: "是否收费",
  ticketPrice: "门票价格",
  reservation: "预约",
  website: "网站",
  phone: "电话",
  wheelchair: "轮椅可达性",
  checkIn: "入住",
  checkOut: "退房",
  address: "地址",
  stayMinutes: "建议游览时长",
};
const labels = {
  fee: {
    yes: "有收费标注，金额与适用范围待核实",
    no: "有不收费标注，适用范围待核实",
    donation: "建议捐赠",
  },
  wheelchair: {
    yes: "标注可通行",
    no: "标注不可通行",
    limited: "部分可通行，具体设施待核实",
  },
  reservation: {
    yes: "需要预约",
    no: "标注无需预约",
    required: "必须预约",
    recommended: "建议预约",
    members_only: "仅会员可预约",
  },
  access: {
    yes: "标注可进入",
    no: "标注禁止进入",
    private: "私人区域",
    customers: "仅顾客",
    permissive: "许可通行，许可可能调整",
    destination: "仅目的地通行",
  },
};
export function factValue(field, value) {
  if (value == null || value === "") return "";
  if (
    field === "ticketPrice" &&
    typeof value === "object" &&
    Number.isFinite(value.amount)
  )
    return `${value.amount} ${value.currency}${Number.isFinite(value.offPeakAmount) ? `（淡季 ${value.offPeakAmount} ${value.currency}；旺季月份：${value.peakMonths?.join("、") || ""}）` : ""}`;
  if (field === "stayMinutes" && Number.isFinite(value)) return `${value} 分钟`;
  return labels[field]?.[value] || String(value);
}
export function safeSourceUrl(value) {
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function knownFact(f) {
  if (
    !f ||
    ["unknown", "needs_review", "conflicting"].includes(f.status) ||
    f.value == null ||
    f.value === ""
  )
    return false;
  if (
    f.evidence?.reviewAfter &&
    !(Date.parse(f.evidence.reviewAfter) > Date.now())
  )
    return false;
  return true;
}
export function travelInformation(place) {
  const groups = {
    accommodation: [
      "checkIn",
      "checkOut",
      "reservation",
      "address",
      "phone",
      "wheelchair",
    ],
    food: ["openingHours", "reservation", "address", "phone", "wheelchair"],
    rest: ["openingHours", "access", "wheelchair"],
    transport: ["openingHours", "access", "wheelchair"],
  };
  const fields = groups[place.category] || [
    "openingHours",
    "lastEntry",
    "reservation",
    "ticketPrice",
    "access",
    "wheelchair",
  ];
  const known = fields.filter((k) => knownFact(place.facts?.[k]));
  return {
    fields,
    known,
    missing: fields.filter((k) => !known.includes(k)),
    knownCount: known.length,
    total: fields.length,
  };
}
