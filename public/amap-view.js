"use strict";
let map,
  payload,
  lastFitKey,
  fitting = false,
  fitTimer,
  detailThreshold = 9,
  userGesture = false;
let detailLayers = [],
  cityLayers = [],
  visibleView = "overview";
const home = new URLSearchParams(location.search).get("mode") === "home";
const status = document.querySelector("#status");
const escapeText = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
if (home) document.body.classList.add("home");
for (const event of ["pointerdown", "touchstart", "wheel", "keydown"])
  document.querySelector("#map").addEventListener(
    event,
    () => {
      userGesture = true;
    },
    { passive: true },
  );
function showLayers(view) {
  visibleView = view;
  for (const p of detailLayers) view === "day" ? p.show() : p.hide();
  for (const p of cityLayers) view === "overview" ? p.show() : p.hide();
  const legend = document.querySelector("#route-legend");
  legend.hidden = !(view === "overview"
    ? payload?.cityConnections?.length
    : payload?.connections?.length);
  legend.textContent =
      payload?.kind === 'citywalk' ? 'CityWalk · 顺序连线' : view === "overview" ? "旅行总览 · 行程连线" : "每日行程 · 顺序连线";
}
function onZoom() {
  if (!payload || payload.lockView || fitting || !userGesture) return;
  userGesture = false;
  const zoom = map.getZoom();
  // Hysteresis avoids flickering when a pinch ends on the transition boundary.
  const view =
    zoom < detailThreshold - 0.35
      ? "overview"
      : zoom > detailThreshold + 0.35
        ? "day"
        : visibleView;
  if (view === visibleView) return;
  showLayers(view);
  let day;
  if (view === "day" && payload.days?.length) {
    const center = map.getCenter();
    day = [...payload.days].sort(
      (a, b) =>
        ((a.position[0] - center.lng) *
          Math.cos((center.lat * Math.PI) / 180)) **
          2 +
          (a.position[1] - center.lat) ** 2 -
          (((b.position[0] - center.lng) *
            Math.cos((center.lat * Math.PI) / 180)) **
            2 +
            (b.position[1] - center.lat) ** 2) ||
        (a.index === payload.day ? -1 : b.index === payload.day ? 1 : 0),
    )[0].index;
  }
  parent.postMessage(
    { type: "seatraces-map-view", view, day },
    location.origin,
  );
}
function curves(connections, color) {
  return (connections || [])
    .filter((c) => c.path?.length > 1)
    .map(
      (c) =>
        new AMap.Polyline({
          path: c.path,
          strokeColor: color,
          strokeWeight: 5,
          strokeStyle: "solid",
          outlineColor: "#fffdf2",
          isOutline: true,
          borderWeight: 2,
          lineJoin: "round",
          lineCap: "round",
        }),
    );
}
function pins(points, overview = false) {
  return (points || []).map(
    (p, i) =>
      new AMap.Marker({
        position: p.position,
        anchor: "bottom-center",
        content:
          '<div class="map-callout"><div class="map-pin"><b>' +
          (overview && p.id === "origin" ? "起" : i + 1) +
          "</b><span>" +
          escapeText(p.name) +
          '</span></div><span class="pin-stem" style="height:8px"></span><span class="pin-dot"></span></div>',
      }),
  );
}
function paint() {
  if (!map || !payload) return;
  map.clearMap();
  detailLayers = [
    ...curves(payload.connections, "#168c81"),
    ...pins(payload.stops),
  ];
  cityLayers = [
    ...curves(payload.cityConnections, "#df7956"),
    ...pins(payload.cities, true),
  ];
  map.add([...detailLayers, ...cityLayers]);
  showLayers(payload.view === "day" ? "day" : "overview");
  const active = visibleView === "overview" ? cityLayers : detailLayers;
  if (!active.length && payload.kind === 'citywalk' && payload.focus?.length === 2 && payload.focus.every(Number.isFinite) && lastFitKey !== payload.fitKey) {
    lastFitKey = payload.fitKey;
    map.setZoomAndCenter(11, payload.focus);
  }
  if (active.length && lastFitKey !== payload.fitKey) {
    lastFitKey = payload.fitKey;
    const raw = payload.viewPadding || [88, 38, 45, 45];
    const padding = raw.map((n, i) =>
      Math.max(
        16,
        Math.min(
          Number(n) || 0,
          (i < 2 ? innerHeight : innerWidth) * (i === 0 ? 0.4 : 0.25),
        ),
      ),
    );
    fitting = true;
    userGesture = false;
    clearTimeout(fitTimer);
    // Only this view's curves and markers take part in fitting. Roads and
    // distant city markers never enlarge a daily route's bounding rectangle.
    map.setFitView(
      active,
      false,
      padding,
      visibleView === "overview" ? 12 : 19,
    );
    if (visibleView === "day") detailThreshold = Math.min(9, map.getZoom() - 1);
    fitTimer = setTimeout(() => {
      fitting = false;
    }, 700);
  }
  if (home) status.hidden = true;
}
window.addEventListener("message", (e) => {
  if (
    e.origin !== location.origin ||
    e.source !== parent ||
    !["seatraces-route", "seatraces-overview"].includes(e.data?.type) ||
    !Array.isArray(e.data.segments)
  )
    return;
  payload = e.data;
  paint();
});
(async () => {
  try {
    const response = await fetch("/api/maps/config", {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw Error("服务暂未连接");
    const config = await response.json();
    if (!config.enabled) {
      status.textContent = home
        ? "地图准备中 · 可以先制订旅行方案"
        : "高德地图显示待配置";
      return;
    }
    window._AMapSecurityConfig = {
      serviceHost: location.origin + "/_AMapService",
    };
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src =
        "https://webapi.amap.com/maps?v=2.0&key=" +
        encodeURIComponent(config.jsKey);
      script.onload = resolve;
      script.onerror = () => reject(Error("地图暂未连上"));
      document.head.append(script);
    });
    map = new AMap.Map("map", {
      zoom: home ? 11 : 13,
      center: home ? [121.4737, 31.2304] : undefined,
      viewMode: "2D",
      mapStyle: "amap://styles/whitesmoke",
    });
    map.on("complete", () => {
      if (home) status.hidden = true;
      parent.postMessage({ type: "seatraces-map-ready" }, location.origin);
      paint();
    });
    map.on("zoomend", onZoom);
    document.querySelector("#zoom-in").onclick = () => {
      userGesture = true;
      map.zoomIn();
    };
    document.querySelector("#zoom-out").onclick = () => {
      userGesture = true;
      map.zoomOut();
    };
    paint();
  } catch (e) {
    status.hidden = false;
    status.textContent = "地图暂未连接 · 可先浏览发现和我的";
  }
})();
