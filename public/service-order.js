export const serviceIcons = {
  dining: "🍜",
  lunch: "🍜",
  dinner: "🍜",
  stay: "🛏",
};
export const servicePriceText = (p) =>
  p.price?.status === "available" && Number.isFinite(p.price.amount)
    ? `人均 ¥${p.price.amount}`
    : "人均 暂无";
export const serviceDistanceText = (n) =>
  Number.isFinite(n)
    ? n < 1000
      ? `${Math.round(n)} 米`
      : `${(n / 1000).toFixed(1)} 公里`
    : "";
export function serviceComparator(sort = "comprehensive") {
  const price = (p) =>
    Number.isFinite(p.price?.amount) && p.price.status === "available"
      ? p.price.amount
      : null;
  return (a, b) => {
    if (sort === "price") {
      const av = price(a),
        bv = price(b);
      if (av == null && bv != null) return 1;
      if (av != null && bv == null) return -1;
      if (av != null && bv != null && av !== bv) return av - bv;
    }
    if (sort === "comprehensive") {
      const cost = (p) =>
        0.75 * (p.distanceMeters / (p.distanceMeters + 800)) +
        0.2 *
          (price(p) == null
            ? 0.5
            : price(p) /
              (price(p) + (p.classification?.category === "food" ? 80 : 400))) +
        0.05 *
          (1 -
            ["phone", "openingHours", "website"].filter(
              (k) => p.facts?.[k]?.value,
            ).length /
              3);
      const difference = cost(a) - cost(b);
      if (difference) return difference;
    }
    return a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id);
  };
}
