export function nameSimilarity(a, b) {
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[\s\p{P}]/gu, "")
      .replace(/旅游景区|风景名胜区|景区/g, "");
  a = norm(a);
  b = norm(b);
  if (!a.length || !b.length) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = old;
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}
