"use strict";
let map,
  mapReady = false,
  payload,
  lastFitKey,
  lastFocusKey,
  fitting = false,
  fitTimer,
  detailThreshold = 9,
  userGesture = false;
let detailLayers = [],
  cityLayers = [],
  visibleView = "overview";
const layerSets = new Map(),
  cameraStates = new Map();
let activeContext,
  manuallyMoved = false,
  boundaryFitted = false;
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      manuallyMoved = true;
    },
    { passive: true },
  );
function showLayers(view) {
  visibleView = view;
  for (const p of detailLayers) view === "day" ? p.show() : p.hide();
  for (const p of cityLayers) view === "overview" ? p.show() : p.hide();
  document.querySelector("#route-legend").hidden = true;
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
function replaceLayer(key, data, build) {
  const signature = JSON.stringify(data ?? null),
    old = layerSets.get(key);
  if (old?.signature === signature) return old.layers;
  if (old) map.remove(old.layers);
  const layers = build();
  if (layers.length) map.add(layers);
  layerSets.set(key, { signature, layers });
  return layers;
}
function interactivePins(points, kind) {
  return (points || []).map((p, i) => {
    const icon =
      kind === "cluster"
        ? p.number
        : { dining: "🍜", lunch: "🍜", dinner: "🍜", stay: "🛏" }[p.kind] ||
          "♥";
    const marker = new AMap.Marker({
      position: p.position,
      anchor: "bottom-center",
      zIndex: p.selected ? 160 : 140,
      content: `<button class="map-action ${kind} ${p.selected ? "selected" : ""}" aria-label="${escapeText(p.name)}" aria-pressed="${Boolean(p.selected)}"><b>${icon}</b><span>${escapeText(p.name)}</span>${p.saved && p.selected ? "<small>✓</small>" : ""}</button>`,
    });
    marker.on("click", () =>
      parent.postMessage(
        {
          type:
            kind === "cluster"
              ? "seatraces-cluster-pick"
              : "seatraces-service-pick",
          id: p.id,
        },
        location.origin,
      ),
    );
    return marker;
  });
}
function boundaries(b, district) {
  if (!b) return [];
  const colors = [
    "#ffdf8e",
    "#bfe7b5",
    "#c7dbf5",
    "#ffc8ac",
    "#e4d6f5",
    "#c7ece1",
  ];
  const polygons = (rings, color, selected = false) =>
    (rings || [])
      .filter((r) => r.length > 2)
      .map(
        (path) =>
          new AMap.Polygon({
            path,
            strokeColor: selected ? "#168c81" : "#ffffff",
            strokeWeight: selected ? 3 : 1,
            strokeOpacity: 0.9,
            fillColor: color,
            fillOpacity: selected ? 0.4 : 0.26,
            zIndex: 40,
            bubble: true,
          }),
      );
  return [
    ...polygons(b.cityRings, "#fff0bf", !(b.districts || []).length),
    ...(b.districts || []).flatMap((d, i) => [
      ...polygons(d.rings, colors[i % colors.length], d.name === district),
      ...(d.center
        ? [
            new AMap.Marker({
              position: d.center,
              anchor: "center",
              zIndex: 50,
              content: `<span class="map-district">${escapeText(d.name)}</span>`,
            }),
          ]
        : []),
    ]),
  ];
}
function paint() {
  if (!map || !mapReady || !payload || !document.querySelector("#map").clientWidth || !document.querySelector("#map").clientHeight) return;
  const context = payload.contextKey || "legacy",
    changed = context !== activeContext;
  if (changed) {
    if (activeContext)
      cameraStates.set(activeContext, {
        center: map.getCenter(),
        zoom: map.getZoom(),
        fitKey: lastFitKey,
        manuallyMoved,
        boundaryFitted,
      });
    while (cameraStates.size > 40)
      cameraStates.delete(cameraStates.keys().next().value);
    activeContext = context;
    manuallyMoved = false;
    boundaryFitted = false;
    lastFocusKey = undefined;
  }
  detailLayers = replaceLayer(
    "route",
    [payload.connections, payload.stops],
    () => [...curves(payload.connections, "#168c81"), ...pins(payload.stops)],
  );
  cityLayers = replaceLayer(
    "overview",
    [payload.cityConnections, payload.cities],
    () => [
      ...curves(payload.cityConnections, "#df7956"),
      ...pins(payload.cities, true),
    ],
  );
  const boundaryLayers = replaceLayer(
    "boundary",
    [payload.boundary, payload.district],
    () => boundaries(payload.boundary, payload.district),
  );
  const clusterLayers = replaceLayer("clusters", payload.clusters, () =>
    interactivePins(payload.clusters, "cluster"),
  );
  const wishLayers = replaceLayer("wishes", payload.wishes, () =>
    pins((payload.wishes || []).map((p) => ({ ...p, name: "♥ " + p.name }))),
  );
  const serviceLayers = replaceLayer("services", payload.services, () =>
    interactivePins(payload.services, "service"),
  );
  const selected = payload.services?.find((p) => p.selected);
  replaceLayer(
    "service-link",
    [selected?.position, payload.serviceAnchor?.position],
    () =>
      selected && payload.serviceAnchor
        ? [
            new AMap.Polyline({
              path: [payload.serviceAnchor.position, selected.position],
              strokeStyle: "dashed",
              strokeColor: "#e3935f",
              strokeWeight: 3,
              zIndex: 70,
            }),
          ]
        : [],
  );
  showLayers(payload.view === "day" ? "day" : "overview");
  let active =
    visibleView === "overview"
      ? cityLayers
      : [...detailLayers, ...serviceLayers];
  if (payload.kind === "planner")
    active = clusterLayers.length ? clusterLayers : boundaryLayers;
  const saved = changed && cameraStates.get(context);
  const raw = payload.viewPadding || [70, 35, 35, 35];
  const padding = raw.map((n, i) =>
    Math.max(
      16,
      Math.min(
        Number(n) || 0,
        (i < 2 ? innerHeight : innerWidth) * (i === 0 ? 0.4 : 0.25),
      ),
    ),
  );
  const beginCamera = () => {
    fitting = true;
    userGesture = false;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(
      () => {
        fitting = false;
      },
      reduced() ? 0 : 700,
    );
  };
  const focus = payload.selectionFocus;
  if (!focus) lastFocusKey = undefined;
  if (
    focus?.key !== lastFocusKey &&
    focus?.position?.length === 2 &&
    focus.position.every(Number.isFinite)
  ) {
    beginCamera();
    map.setZoomAndCenter(
      Math.max(16, map.getZoom()),
      focus.position,
      reduced(),
      450,
    );
    lastFocusKey = focus.key;
    lastFitKey = payload.fitKey;
    manuallyMoved = false;
  } else if (payload.preserveCamera) {
    lastFitKey = payload.fitKey;
    manuallyMoved = true;
  } else if (saved && saved.fitKey === payload.fitKey) {
    beginCamera();
    map.setZoomAndCenter(saved.zoom, saved.center, reduced(), 400);
    lastFitKey = saved.fitKey;
    manuallyMoved = saved.manuallyMoved;
    boundaryFitted = saved.boundaryFitted;
  } else if (
    changed ||
    lastFitKey !== payload.fitKey ||
    (payload.kind === "planner" &&
      !clusterLayers.length &&
      boundaryLayers.length &&
      !boundaryFitted &&
      !manuallyMoved)
  ) {
    beginCamera();
    lastFitKey = payload.fitKey;
    manuallyMoved = false;
    if (active.length) {
      // Fit only the current scene, never the distant origin in a daily view.
      const district = payload.boundary?.districts?.find(
        (d) => d.name === payload.district,
      );
      const bounds =
        !clusterLayers.length && district?.rings?.length
          ? district.rings.map((path) => new AMap.Polygon({ path }))
          : active;
      map.setFitView(
        bounds,
        reduced(),
        padding,
        payload.kind === "planner" ? 16 : visibleView === "overview" ? 12 : 19,
      );
      boundaryFitted = Boolean(boundaryLayers.length);
      if (visibleView === "day" && !payload.lockView)
        detailThreshold = Math.min(9, map.getZoom() - 1);
    } else if (
      payload.focus?.length === 2 &&
      payload.focus.every(Number.isFinite)
    )
      map.setZoomAndCenter(11, payload.focus, reduced(), 500);
  }
  if (changed && !reduced()) {
    const el = document.querySelector("#map");
    el.classList.remove("scene-arrive");
    requestAnimationFrame(() => el.classList.add("scene-arrive"));
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
      mapReady = true;
      if (home) status.hidden = true;
      parent.postMessage({ type: "seatraces-map-ready" }, location.origin);
      paint();
    });
    // A closed details panel has no usable viewport. Fit after it becomes visible.
    let previousSize = '';
    new ResizeObserver(() => {
      const el = document.querySelector('#map'), size = el.clientWidth + ':' + el.clientHeight;
      if(size === previousSize) return;
      previousSize = size;
      if(!el.clientWidth || !el.clientHeight) return;
      if(!manuallyMoved || payload?.lockView) { lastFitKey = undefined; requestAnimationFrame(paint); }
    }).observe(document.querySelector('#map'));
    map.on("zoomend", onZoom);
    document.querySelector("#zoom-in").onclick = () => {
      userGesture = true;
      manuallyMoved = true;
      map.zoomIn();
    };
    document.querySelector("#zoom-out").onclick = () => {
      userGesture = true;
      manuallyMoved = true;
      map.zoomOut();
    };
    paint();
  } catch (e) {
    status.hidden = false;
    status.textContent = "地图暂未连接 · 可先浏览发现和我的";
  }
})();
