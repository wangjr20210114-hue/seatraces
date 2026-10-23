/* 验证地图工作区交互。 */

import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import {
  scenePoint,
  plannerScene,
  serviceScene,
  savedServicePoints,
} from "../public/map-scene.js";

test("map scenes convert mainland coordinates once, preserve foreign points and provider boundaries", () => {
  const beijing = {
    id: "bj",
    country: "CN",
    lat: 39.9,
    lng: 116.4,
    name: "北京",
  };
  assert.notDeepEqual(scenePoint(beijing).position, [116.4, 39.9]);
  assert.deepEqual(
    scenePoint({ ...beijing, crs: "GCJ02" }).position,
    [116.4, 39.9],
  );
  assert.deepEqual(
    scenePoint({ country: "JP", lat: 35, lng: 139 }).position,
    [139, 35],
  );
  assert.equal(scenePoint({ lat: null, lng: 100 }), null);
  assert.deepEqual(
    scenePoint({ ...beijing, country: null }, { country: "CN" }).position,
    scenePoint(beijing).position,
  );
  assert.deepEqual(
    scenePoint({ country: "HK", lat: 22.3, lng: 114.1 }, { country: "CN" })
      .position,
    [114.1, 22.3],
  );
  const boundary = {
    cityRings: [
      [
        [116, 39],
        [117, 39],
        [117, 40],
      ],
    ],
    districts: [],
  };
  const scene = plannerScene({
    city: beijing,
    boundary,
    clusters: [
      {
        id: "a",
        number: 8,
        name: "一片",
        center: beijing,
        districts: [],
        members: [{ ...beijing, id: "want", ownWanted: true }],
      },
    ],
    selected: ["a"],
  });
  assert.equal(scene.boundary, boundary);
  assert.equal(scene.clusters[0].number, 8);
  assert.equal(scene.clusters[0].selected, true);
  assert.equal(scene.wishes.length, 1);
  const args = {
    city: beijing,
    boundary,
    fitKey: "bj",
    clusters: [{ id: "one", center: beijing, members: [] }],
  };
  const before = plannerScene({ ...args, clusters: [] });
  const after = plannerScene(args);
  assert.notEqual(
    before.fitKey,
    after.fitKey,
    "late clusters trigger a new fit",
  );
  assert.equal(
    after.fitKey,
    plannerScene({ ...args, selected: ["one"], boundary: null }).fitKey,
    "selection and boundary do not shrink cluster framing",
  );
});
test("meal overlays keep daily route and saved choices; selecting a pin never changes fit key", () => {
  const p = { id: "food", country: "CN", lat: 31, lng: 121, name: "餐厅" };
  const base = {
    tripId: "trip",
    day: 1,
    stops: [{ id: "s", position: [121, 31] }],
    connections: [
      {
        path: [
          [121, 31],
          [121.1, 31.1],
        ],
      },
    ],
  };
  const slot = {
    id: "lunch:1",
    kind: "lunch",
    radius: 1500,
    anchor: p,
    items: [p],
    selected: { candidate: { ...p, id: "saved" } },
  };
  const a = serviceScene(base, slot, "food"),
    b = serviceScene(base, slot, "saved");
  assert.equal(a.stops, base.stops);
  assert.equal(a.connections, base.connections);
  assert.equal(a.fitKey, b.fitKey);
  assert.notEqual(a.selectionFocus.key, b.selectionFocus.key);
  assert.notEqual(
    a.selectionFocus.key,
    serviceScene(base, slot, "food", 1).selectionFocus.key,
  );
  assert.deepEqual(a.selectionFocus.position, scenePoint(p).position);
  assert.equal(a.services.length, 2);
  assert.equal(b.services.find((p) => p.saved).selected, true);
  assert.notEqual(
    a.contextKey,
    serviceScene(base, { ...slot, id: "stay:1-1" }, "").contextKey,
  );
});

test("saved meals and multi-day lodging reappear only on their associated days", () => {
  const trip = {
    plan: {
      cities: [{ id: "bj", country: "CN" }],
      days: [{ cityId: "bj" }, { cityId: "bj" }],
      services: {
        "lunch:0": {
          slotId: "lunch:0",
          kind: "lunch",
          days: [0],
          candidate: {
            id: "meal",
            name: "餐厅",
            country: null,
            lat: 39.9,
            lng: 116.4,
          },
        },
        "stay:0-1": {
          slotId: "stay:0-1",
          kind: "stay",
          days: [0, 1],
          candidate: {
            id: "hotel",
            name: "住宿",
            country: null,
            lat: 39.91,
            lng: 116.41,
          },
        },
      },
    },
  };
  assert.equal(savedServicePoints(trip, 0).length, 2);
  assert.equal(savedServicePoints(trip, 1).length, 1);
  assert.equal(savedServicePoints(trip, 1)[0].slotId, "stay:0-1");
  assert.deepEqual(
    savedServicePoints(trip, 0)[0].position,
    scenePoint({ ...trip.plan.services["lunch:0"].candidate, country: "CN" })
      .position,
  );
});
test("map layer updates preserve route, user camera and context; only explicit scene fits animate", async () => {
  const source = await readFile(
    new URL("../public/amap-view.js", import.meta.url),
    "utf8",
  );
  const listeners = {},
    nodes = new Map(),
    sent = [],
    fits = [],
    moves = [],
    removed = [];
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, {
        hidden: false, clientWidth:390, clientHeight:400,
        classList: { add() {}, remove() {} },
        addEventListener(name, fn) {
          listeners[id + name] = fn;
        },
      });
    return nodes.get(id);
  };
  class Overlay {
    constructor(opts) {
      this.opts = opts;
    }
    show() {}
    hide() {}
    on(name, fn) {
      this[name] = fn;
    }
  }
  const fakeMap = {
    add() {},
    remove(x) {
      removed.push(x);
    },
    getCenter() {
      return { lng: 120, lat: 30 };
    },
    getZoom() {
      return 13;
    },
    setFitView(...args) {
      fits.push(args);
    },
    setZoomAndCenter(...args) {
      moves.push(args);
    },
  };
  const context = vm.createContext({
    document: { querySelector: node, body: { classList: { add() {} } } },
    location: { origin: "http://test", search: "?mode=home" },
    parent: {
      postMessage(m) {
        sent.push(m);
      },
    },
    window: {
      addEventListener(k, fn) {
        listeners[k] = fn;
      },
    },
    URLSearchParams,
    Map,
    Number,
    Math,
    JSON,
    Array,
    String,
    innerHeight: 400,
    innerWidth: 390,
    matchMedia: () => ({ matches: true }),
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
    fetch: async () => ({ ok: true, json: async () => ({ enabled: false }) }),
    AMap: { Marker: Overlay, Polyline: Overlay, Polygon: Overlay },
    fakeMap,
  });
  vm.runInContext(source, context);
  vm.runInContext("map=fakeMap;mapReady=true", context);
  const send = (data) =>
    listeners.message({
      origin: "http://test",
      source: context.parent,
      data: { type: "seatraces-overview", segments: [], view: "day", ...data },
    });
  const route = {
    contextKey: "day:0",
    fitKey: "day:0:1",
    stops: [{ name: "景点", position: [121, 31] }],
    connections: [],
  };
  send(route);
  assert.equal(fits.length, 1);
  send({
    ...route,
    services: [{ id: "a", kind: "lunch", position: [121.001, 31], name: "店" }],
  });
  assert.equal(fits.length, 1);
  assert.equal(
    removed.some((items) =>
      items.some((p) => p.opts?.content?.includes("景点")),
    ),
    false,
  );
  send({ ...route, contextKey: "meal", fitKey: "meal" });
  assert.equal(fits.length, 2);
  send(route);
  assert.equal(moves.length, 1);
  assert.equal(fits.length, 2);
  send({
    kind: "planner",
    contextKey: "city",
    fitKey: "city",
    focus: [116, 39],
  });
  listeners["#mappointerdown"]();
  send({
    kind: "planner",
    contextKey: "city",
    fitKey: "city",
    focus: [116, 39],
    boundary: {
      cityRings: [
        [
          [116, 39],
          [117, 39],
          [117, 40],
        ],
      ],
      districts: [],
    },
  });
  assert.equal(fits.length, 2);
  const groups = [
    { id: "c1", name: "西片", number: 1, position: [116.39, 39.9] },
    { id: "c2", name: "东片", number: 2, position: [116.41, 39.91] },
  ];
  const cityBoundary = {
    cityRings: [
      [
        [115, 38],
        [118, 38],
        [118, 41],
      ],
    ],
    districts: [],
  };
  send({
    kind: "planner",
    contextKey: "city",
    fitKey: "city:clusters",
    clusters: groups,
    boundary: cityBoundary,
  });
  assert.equal(fits.length, 3);
  assert.equal(fits.at(-1)[0].length, 2);
  assert.ok(
    fits.at(-1)[0].every((p) => p.opts.content?.includes("cluster")),
    "fit actual clusters, not the large administrative boundary",
  );
  send({
    kind: "planner",
    contextKey: "city",
    fitKey: "city:clusters",
    clusters: groups,
    boundary: {
      ...cityBoundary,
      districts: [{ name: "一区", rings: cityBoundary.cityRings }],
    },
  });
  assert.equal(
    fits.length,
    3,
    "late boundary must not shrink already visible clusters",
  );
  const service = {
    ...route,
    contextKey: "service",
    fitKey: "service:batch",
    selectionFocus: { key: "a:1", position: [121.02, 31.01] },
  };
  const before = moves.length;
  send(service);
  assert.equal(moves.length, before + 1);
  assert.equal(moves.at(-1)[0], 16);
  assert.deepEqual(Array.from(moves.at(-1)[1]), [121.02, 31.01]);
  send(service);
  assert.equal(moves.length, before + 1, "repaint is not a new focus request");
  listeners["#mappointerdown"]();
  send({
    ...service,
    selectionFocus: { ...service.selectionFocus, key: "a:2" },
  });
  assert.equal(
    moves.length,
    before + 2,
    "repeat selection recenters after a manual pan",
  );
});
