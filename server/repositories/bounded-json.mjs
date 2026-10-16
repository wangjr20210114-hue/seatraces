// Conservative size check before serializing cache entries. An oversized live
// response still reaches its caller; only its optional cache copy is skipped.
export function boundedJsonBytes(value, limit) {
  const stack = [value],
    seen = new WeakSet();
  let bytes = 0;
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") {
      const raw = Buffer.byteLength(v);
      bytes += raw + 2;
      if (bytes <= limit)
        bytes += Buffer.byteLength(JSON.stringify(v)) - raw - 2;
    } else if (v === null || typeof v === "number" || typeof v === "boolean")
      bytes += JSON.stringify(v)?.length || 4;
    else if (typeof v === "object") {
      if (seen.has(v)) return Infinity;
      seen.add(v);
      const keys = Object.keys(v);
      bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        if (!Array.isArray(v))
          bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        stack.push(v[key]);
      }
    } else bytes += 4;
    if (bytes > limit) return Infinity;
  }
  return bytes;
}
