/* 校验修改请求的来源和标头。 */

const localOrigins = [
  'http://127.0.0.1:8787', 'http://127.0.0.1:8788',
  'http://localhost:8787', 'http://localhost:8788',
];

function parseOrigin(value, configuration = false) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    if (!configuration && text !== url.origin) return null;
    return url.origin;
  } catch { return null; }
}

export function createSourceCheck({
  appOrigin = process.env.APP_ORIGIN || '',
  production = process.env.NODE_ENV === 'production',
} = {}) {
  const configured = appOrigin ? parseOrigin(appOrigin, true) : null;
  if (appOrigin && !configured) throw Error('APP_ORIGIN must be an HTTP(S) origin without credentials, a path, query or fragment');
  const allowed = new Set(production ? [] : localOrigins);
  if (configured) allowed.add(configured);
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const reject = () => res.status(403).json({error: '请求来源校验失败'});
    if (req.get('X-Seatraces') !== '1' || req.get('Sec-Fetch-Site')?.toLowerCase() === 'cross-site') return reject();
    if (req.headers.origin !== undefined) {
      const origin = parseOrigin(req.get('Origin'));
      const port = req.socket.localPort;
      const local = !production && ['127.0.0.1', 'localhost', '[::1]'].some(host => origin === `http://${host}:${port}`);
      if (!origin || (!allowed.has(origin) && !local)) return reject();
    }
    next();
  };
}
