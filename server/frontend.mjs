import express from "express";
import helmet from "helmet";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const publicRoot = fileURLToPath(new URL("../public/", import.meta.url));
const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function endToEndHeaders(headers) {
  const blocked = new Set([...hopHeaders, ...String(headers.connection || "").toLowerCase().split(",").map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

// Static UI has no PostgreSQL, seed, OSM, or credential dependency. Only explicit
// API/map-proxy paths go to one configured backend; this is not an open proxy.
export function createFrontend({ backendOrigin = "http://127.0.0.1:8787", proxyTimeoutMs = 120000 } = {}) {
  const backend = new URL(backendOrigin);
  if (!["http:", "https:"].includes(backend.protocol) || backend.username || backend.password || backend.pathname !== "/" || backend.search || backend.hash)
    throw Error("Frontend API origin must be an HTTP(S) origin without credentials");
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:"], connectSrc: ["'self'"], upgradeInsecureRequests: null,
  } }, crossOriginEmbedderPolicy: false }));
  app.get("/frontend-health", (req, res) => res.json({ ok: true, service: "seatraces-frontend" }));
  app.use((req, res, next) => {
    if (!/^\/(?:api|_AMapService)(?:\/|\?|$)/.test(req.originalUrl)) return next();
    const request = (backend.protocol === "https:" ? https : http).request({
      protocol: backend.protocol, hostname: backend.hostname, port: backend.port,
      method: req.method, path: req.originalUrl,
      headers: { ...endToEndHeaders(req.headers), host: backend.host },
    }, upstream => {
      res.writeHead(upstream.statusCode || 502, endToEndHeaders(upstream.headers));
      upstream.on("error", () => res.destroy());
      upstream.pipe(res);
    });
    request.setTimeout(proxyTimeoutMs, () => request.destroy(Error("upstream_timeout")));
    request.on("error", () => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      res.set("Cache-Control", "no-store").status(503).json({
        code: "backend_unavailable", error: "暂时连不上服务，请稍后重试。页面仍可浏览。",
      });
    });
    req.on("aborted", () => request.destroy());
    res.on("close", () => { if (!res.writableFinished) request.destroy(); });
    req.pipe(request);
  });
  app.get("/amap-view.html", helmet.referrerPolicy({ policy: "strict-origin-when-cross-origin" }), helmet.contentSecurityPolicy({ directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-eval'", "https://webapi.amap.com", "https://*.amap.com"],
    styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", "data:", "blob:", "https://*.amap.com", "https://*.autonavi.com"],
    connectSrc: ["'self'", "https://*.amap.com", "https://*.autonavi.com"], workerSrc: ["'self'", "blob:"], upgradeInsecureRequests: null,
  } }), (req, res) => res.sendFile(path.join(publicRoot, "amap-view.html")));
  app.get("/google-view.html", helmet.contentSecurityPolicy({ directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-eval'", "https://maps.googleapis.com", "https://maps.gstatic.com", "blob:"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], fontSrc: ["'self'", "https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:", "blob:", "https://*.googleapis.com", "https://*.gstatic.com", "https://*.google.com", "https://*.googleusercontent.com"],
    connectSrc: ["'self'", "https://*.googleapis.com", "https://*.gstatic.com", "https://*.google.com", "data:", "blob:"],
    frameSrc: ["https://*.google.com"], workerSrc: ["'self'", "blob:"], upgradeInsecureRequests: null,
  } }), (req, res) => res.sendFile(path.join(publicRoot, "google-view.html")));
  app.get(["/legacy.html", "/catalog.html"], (req, res) => res.redirect(302, "/"));
  app.use(express.static(publicRoot, { maxAge: 0, dotfiles: "deny" }));
  return app;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  createFrontend({ backendOrigin: process.env.FRONTEND_API_ORIGIN || "http://127.0.0.1:8787" })
    .listen(Number(process.env.FRONTEND_PORT || 8788), "127.0.0.1", () => console.log("SeaTraces frontend ready on http://127.0.0.1:" + (process.env.FRONTEND_PORT || 8788)));
}
