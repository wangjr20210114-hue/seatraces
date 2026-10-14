function offset(lat, lng) {
  const x = lng - 105,
    y = lat - 35,
    pi = Math.PI;
  let a =
    -100 +
    2 * x +
    3 * y +
    0.2 * y * y +
    0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  let b =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  a +=
    ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3 +
    ((20 * Math.sin(y * pi) + 40 * Math.sin((y / 3) * pi)) * 2) / 3 +
    ((160 * Math.sin((y / 12) * pi) + 320 * Math.sin((y * pi) / 30)) * 2) / 3;
  b +=
    ((20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2) / 3 +
    ((20 * Math.sin(x * pi) + 40 * Math.sin((x / 3) * pi)) * 2) / 3 +
    ((150 * Math.sin((x / 12) * pi) + 300 * Math.sin((x / 30) * pi)) * 2) / 3;
  const rad = (lat * pi) / 180,
    m = 1 - 0.00669342162296594323 * Math.sin(rad) ** 2;
  return [
    (a * 180) /
      (((6378245 * (1 - 0.00669342162296594323)) / (m * Math.sqrt(m))) * pi),
    (b * 180) / ((6378245 / Math.sqrt(m)) * Math.cos(rad) * pi),
  ];
}
export const toGcj = (p) => {
  const [a, b] = offset(p.lat, p.lng);
  return [(p.lng + b).toFixed(6), (p.lat + a).toFixed(6)].join(",");
};
export function toWgs(polyline) {
  return String(polyline || "")
    .split(";")
    .filter(Boolean)
    .map((s) => {
      const [lng, lat] = s.split(",").map(Number);
      const [a, b] = offset(lat, lng);
      return [lat - a, lng - b];
    })
    .filter((p) => p.every(Number.isFinite));
}
export function mainlandEligible(p) {
  if(['HK','MO','TW'].includes(p.country))return false;
  if(p.country!=='CN'&&p.extract_region!=='china')return false;
  // Conservative geographic guard for the China extract's HK/Macao overlap.
  if(p.lat<22.6&&p.lng>113.45&&p.lng<114.6&&!p.mainlandCityVerified)return false;
  return p.lng>=73.5&&p.lng<=135.1&&p.lat>=18&&p.lat<=53.6;
}
