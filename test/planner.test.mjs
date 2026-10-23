/* 验证行程安排与时间预算。 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  datesBetween,
  makePlan,
  applyEdit,
  schedule,
  distance,
} from "../server/planner.mjs";
import {
  normalizeTransit,
  toGcj,
  toWgs,
  nameSimilarity,
} from "../server/providers.mjs";
const p = (id, extra = {}) => ({
  id,
  name: id,
  city: "苏州",
  lat: 31.31,
  lng: 120.62,
  category: "attraction",
  tags: ["园林"],
  duration_min: 90,
  hours: {
    open: "09:00",
    close: "18:00",
    lastEntry: "16:30",
    closedWeekdays: [],
  },
  ...extra,
});
test("date validation handles reverse, leap day and bounded length", () => {
  assert.throws(() => datesBetween("2026-02-29", "2026-03-01"));
  assert.throws(() => datesBetween("2026-10-12", "2026-10-11"));
  assert.throws(() => datesBetween("2026-10-01", "2026-11-01"));
  assert.equal(datesBetween("2028-02-28", "2028-03-01").length, 3);
});
test("closed weekdays and entry windows reject impossible stops", () => {
  const r = schedule(
    [
      p("closed", {
        hours: {
          open: "09:00",
          close: "18:00",
          lastEntry: "16:00",
          closedWeekdays: [1],
        },
      }),
      p("late", {
        hours: {
          open: "17:00",
          close: "18:00",
          lastEntry: "17:30",
          closedWeekdays: [],
        },
      }),
    ],
    "2026-10-12",
  );
  assert.equal(r.stops.length, 0);
  assert.equal(r.warnings.length, 2);
});
test("plan allocates each stop at most once and flags missing destination data", () => {
  const cities = [
      { id: "suzhou", name: "苏州", timezone: "Asia/Shanghai" },
      { id: "empty", name: "空城", timezone: "Asia/Shanghai" },
    ],
    req = {
      start: "2026-10-12",
      end: "2026-10-14",
      pace: "balanced",
      interests: ["园林"],
    };
  const r = makePlan(req, cities, [p("a"), p("b"), p("c")]);
  const ids = r.days.flatMap((d) => d.stops.map((x) => x.id));
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(r.warnings.some((x) => x.includes("暂无足够")));
  assert.equal(r.transfers[0].status, "needs_live_query");
});
test("locked stops resist assistant/manual removal, duplication and infeasible replacements", () => {
  const plan = {
    pace: "balanced",
    days: [
      {
        city: "苏州",
        date: "2026-10-12",
        stops: [p("a", { locked: true }), p("b")],
      },
    ],
  };
  assert.throws(
    () => applyEdit(plan, { type: "remove", day: 0, placeId: "a" }, []),
    /解锁/,
  );
  assert.throws(
    () => applyEdit(plan, { type: "add", day: 0, newPlaceId: "b" }, [p("b")]),
    /已有/,
  );
  assert.throws(
    () =>
      applyEdit(
        plan,
        { type: "replace", day: 0, placeId: "b", newPlaceId: "c" },
        [p("c", { duration_min: 1400 })],
      ),
    /时段/,
  );
  assert.equal(plan.days[0].stops.length, 2);
});
test('move inserts the selected stop and preserves every intervening stop',()=>{
  const plan={pace:'balanced',days:[{city:'苏州',date:'2026-10-24',stops:['a','b','c','d'].map(id=>p(id,{duration_min:30}))},
    {city:'苏州',date:'2026-10-25',stops:[p('other')]}]};
  for(const [from,to,expected] of [
    ['a',3,['b','c','d','a']],['d',0,['d','a','b','c']],
    ['b',2,['a','c','b','d']],['c',1,['a','c','b','d']],['b',1,['a','b','c','d']],
  ]){
    const changed=applyEdit(plan,{type:'move',day:0,placeId:from,to},[]);
    assert.deepEqual(changed.days[0].stops.map(p=>p.id),expected);
    assert.deepEqual(changed.days[1],plan.days[1]);
    assert.deepEqual(plan.days[0].stops.map(p=>p.id),['a','b','c','d']);
  }
});

test('move cannot shift a locked stop or accept a missing/noninteger target',()=>{
  const plan={pace:'balanced',days:[{city:'苏州',date:'2026-10-24',stops:['a','b','c','d'].map(id=>p(id,{duration_min:30,locked:id==='b'}))}]};
  for(const [placeId,to] of [['a',3],['d',0],['a',1],['b',3]]){
    assert.throws(()=>applyEdit(plan,{type:'move',day:0,placeId,to},[]),e=>e.status===409);
  }
  for(const to of [undefined,-1,4,1.5]){
    assert.throws(()=>applyEdit(plan,{type:'move',day:0,placeId:'c',to},[]),e=>e.status===400);
  }
  assert.deepEqual(applyEdit(plan,{type:'move',day:0,placeId:'c',to:2},[]),plan,'an unchanged position must not reschedule the day');
});

test("geographical distance and coordinate projection are plausible", () => {
  assert.equal(distance(p("a"), p("b")), 0);
  const coord = toGcj({ lat: 31.31, lng: 120.62 }),
    back = toWgs(coord)[0];
  assert.ok(Math.abs(back[0] - 31.31) < 0.00005);
  assert.ok(Math.abs(back[1] - 120.62) < 0.00005);
});
test("name matching tolerates scenic-area suffix and exposes weak typo matches", () => {
  assert.equal(nameSimilarity("拙政园景区", "拙政园"), 1);
  assert.ok(nameSimilarity("拙政园", "拙证园") > 0.6);
  assert.ok(nameSimilarity("拙政园", "天坛公园") < 0.5);
});
test("public transit is split walk → metro → walk, not flattened into one leg", () => {
  const routes = normalizeTransit([
    {
      duration: "1800",
      segments: [
        {
          walking: {
            duration: "120",
            steps: [
              { instruction: "到车站", polyline: "120.1,31.1;120.2,31.2" },
            ],
          },
          bus: {
            buslines: [
              {
                name: "地铁1号线",
                duration: "1200",
                departure_stop: { name: "甲站" },
                arrival_stop: { name: "乙站" },
                polyline: "120.2,31.2;120.3,31.3",
              },
            ],
          },
        },
        {
          walking: {
            duration: "180",
            steps: [
              { instruction: "步行至景点", polyline: "120.3,31.3;120.4,31.4" },
            ],
          },
        },
      ],
    },
  ]);
  assert.deepEqual(
    routes[0].segments.map((s) => s.mode),
    ["walk", "metro", "walk"],
  );
  assert.equal(routes[0].minutes, 30);
});
