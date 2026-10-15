import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";

test("day fit excludes city/road overlays; user zoom switches layers without refitting or changing a same-city day", async () => {
  const listeners = {},
    mapEvents = {},
    elements = new Map();
  const element = (id) =>
    elements.get(id) ||
    elements
      .set(id, {
        addEventListener: (name, fn) => {
          listeners[name] = fn;
        },
        classList: { add() {} },
        append() {},
      })
      .get(id);
  const fits = [],
    messages = [];
  let map;
  class Overlay {
    constructor(options) {
      this.options = options;
    }
    show() {}
    hide() {}
  }
  class MapStub {
    constructor() {
      map = this;
      this.zoom = 10;
    }
    on(event, fn) {
      mapEvents[event] = fn;
    }
    clearMap() {}
    add() {}
    remove() {}
    getZoom() {
      return this.zoom;
    }
    getCenter() {
      return { lng: 116.4, lat: 39.9 };
    }
    setFitView(items, immediate, padding, maxZoom) {
      fits.push({ items, padding, maxZoom });
      this.zoom = maxZoom === 12 ? 6 : 15;
    }
  }
  const context = vm.createContext({
    URLSearchParams,
    console,
    innerWidth: 390,
    innerHeight: 440,
    matchMedia: () => ({ matches: true }),
    location: { origin: "http://local", search: "?mode=home" },
    parent: { postMessage: (value) => messages.push(value) },
    window: {
      addEventListener: (event, fn) => {
        listeners[event] = fn;
      },
    },
    document: {
      querySelector: element,
      body: { classList: { add() {} } },
      head: { append: (script) => script.onload() },
      createElement: () => ({}),
    },
    AMap: { Map: MapStub, Marker: Overlay, Polyline: Overlay },
    AbortSignal,
    fetch: async () => ({
      ok: true,
      json: async () => ({ enabled: true, jsKey: "test" }),
    }),
    setTimeout: (fn) => {
      listeners.fitDone = fn;
      return 1;
    },
    clearTimeout() {},
  });
  vm.runInContext(
    await fs.readFile(
      new URL("../public/amap-view.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  await new Promise((resolve) => setImmediate(resolve));
  const post = (data) =>
    listeners.message({ origin: "http://local", source: context.parent, data });
  const payload = {
    type: "seatraces-overview",
    view: "day",
    day: 1,
    fitKey: "day1",
    viewPadding: [126, 38, 45, 45],
    stops: [
      { name: "故宫", position: [116.39, 39.92] },
      { name: "景山", position: [116.39, 39.93] },
    ],
    connections: [
      {
        path: [
          [116.39, 39.92],
          [116.39, 39.93],
        ],
      },
    ],
    cities: [
      { name: "上海", position: [121.4, 31.2] },
      { name: "北京", position: [116.4, 39.9] },
    ],
    cityConnections: [
      {
        path: [
          [121.4, 31.2],
          [116.4, 39.9],
        ],
      },
    ],
    segments: [
      {
        mapPolyline: [
          [0, 0],
          [180, 80],
        ],
      },
    ],
    days: [
      { index: 0, position: [116.4, 39.9] },
      { index: 1, position: [116.4, 39.9] },
    ],
  };
  post(payload);
  assert.equal(fits.length, 1);
  assert.equal(fits[0].items.length, 3);
  assert.ok(
    fits[0].items.every((p) => !(p.options.content || "").includes("上海")),
  );
  listeners.fitDone();
  mapEvents.zoomend();
  assert.equal(messages.length, 0);
  post(payload);
  assert.equal(fits.length, 1);
  listeners.wheel();
  map.zoom = 6;
  mapEvents.zoomend();
  assert.equal(messages.at(-1).view, "overview");
  listeners.wheel();
  map.zoom = 12;
  mapEvents.zoomend();
  assert.equal(messages.at(-1).view, "day");
  assert.equal(messages.at(-1).day, 1);
  assert.equal(fits.length, 1);
  post({ ...payload, view: "overview", fitKey: "overview" });
  assert.equal(fits.length, 2);
  assert.ok(
    fits[1].items.some((p) => (p.options.content || "").includes("上海")),
  );
  post({ ...payload, kind: 'citywalk', lockView: true, view: 'day', fitKey: 'citywalk', cities: [], cityConnections: [] });
  listeners.fitDone();
  const count = messages.length;
  listeners.wheel(); map.zoom = 6; mapEvents.zoomend();
  assert.equal(messages.length, count, 'zooming a CityWalk must not switch to an empty overview');
  assert.equal(fits.at(-1).items.length, 3, 'CityWalk fits its two stops and connecting curve');
});
