/* 验证行程候选地点读取的内存占用。 */

import { compactJourneyCatalogs } from "../server/repositories/compact-journeys.mjs";
import { journeyPlaceDetail } from "../server/services/journey-details.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { journeyFixture as iterationFixture } from "./helpers/journey-db.mjs";
import {
  planningPools,
  catalogMember,
  catalogCoordinates,
} from "../server/repositories/journey-candidates.mjs";
import {
  scenicSummary,
  scenicSummarySql,
} from "../server/domain/scenic-summary.mjs";
import { selectedPools } from "../server/services/journey-service.mjs";
const point = (i) => ({
  id: "p" + i,
  name: "景点" + i,
  lat: 31 + i / 10000,
  lng: 121,
  children: [],
});
test(
  "planning reads only scoped shortlist and preserves existing candidate policy",
  { skip: process.env.TEST_OPERATIONS !== "1", timeout: 90000 },
  async (t) => {
    const f = await iterationFixture({ schemas: ["schema.sql"] });
    const id = randomUUID(),
      userId = f.users.user.id;
    const run = (catalog, selections, wishes = {}) =>
      planningPools({
        query: f.query,
        sessionId: id,
        userId,
        cities: [{ id: "a" }],
        selections,
        wishes,
      });
    try {
      await f.query(
        "INSERT INTO journey_sessions(id,user_id,request) VALUES($1,$2,'{}')",
        [id, userId],
      );
      const members = Array.from({ length: 150 }, (_, i) => point(i));
      members[80].children = [
        { id: "child80", possibleDuplicateIds: ["child-alias"], children: [] },
      ];
      members[90].possibleDuplicateIds = ["alias90"];
      members[100].wanted = true;
      const catalog = {
        a: {
          clusters: [
            { id: "x", members },
            {
              id: "y",
              members: [
                { ...point(149), name: "the early duplicate" },
                point(200),
                point(201),
              ],
            },
          ],
        },
      };
      await f.query("UPDATE journey_sessions SET catalog=$2 WHERE id=$1", [
        id,
        JSON.stringify(catalog),
      ]);
      await t.test(
        "JM01 round-robin duplicates, descendant wishes, aliases and stale wishes",
        async () => {
          for (const selections of [
            { a: ["x", "y"] },
            { a: ["y", "x"] },
            { a: ["x"] },
          ])
            for (const wishes of [
              {},
              { "child-alias": true, alias90: true, p100: false },
              Object.fromEntries(
                Array.from({ length: 80 }, (_, i) => ["p" + i, true]),
              ),
            ]) {
              const actual = await run(catalog, selections, wishes),
                expected = selectedPools(
                  catalog,
                  selections,
                  [{ id: "a" }],
                  wishes,
                );
              assert.deepEqual(actual, {
                a: expected.a.map((p) => scenicSummary(p)),
              });
            }
        },
      );
      await t.test(
        "JM02 unknown city/cluster, duplicates and foreign owner fail closed",
        async () => {
          for (const selections of [
            { a: [] },
            { a: ["foreign"] },
            { a: ["x", "x"] },
          ])
            await assert.rejects(
              run(catalog, selections),
              (e) => e.status === 400,
            );
          await assert.rejects(
            planningPools({
              query: f.query,
              sessionId: id,
              userId: f.users.other.id,
              cities: [{ id: "a" }],
              selections: { a: ["x"] },
            }),
            (e) => e.status === 404,
          );
          assert.equal(
            await catalogMember({
              query: f.query,
              sessionId: id,
              userId: f.users.other.id,
              placeId: "p1",
            }),
            null,
          );
        },
      );
      await t.test(
        "JM03 wishes and boundary endpoints need only IDs/aliases/coordinates",
        async () => {
          assert.equal(
            await catalogMember({
              query: f.query,
              sessionId: id,
              userId,
              placeId: "child80",
            }),
            null,
          );
          assert.equal(
            (
              await catalogMember({
                query: f.query,
                sessionId: id,
                userId,
                placeId: "child80",
                includeChildren: true,
              })
            ).id,
            "child80",
          );
          const coords = await catalogCoordinates({
            query: f.query,
            sessionId: id,
            userId,
            cityId: "a",
          });
          assert.equal(coords.length, 2);
          assert.equal(coords[0].members.length, 150);
          assert.deepEqual(Object.keys(coords[0].members[0]).sort(), [
            "lat",
            "lng",
          ]);
        },
      );
      await t.test(
        "JM06 detail fetch is lazy and owned; provider failures do not become invented data",
        async () => {
          await f.query(
            "INSERT INTO scenic_hierarchy_results(place_id,input_hash,source_hash,result,checked_at,review_after) VALUES('p1','fixture','fixture','{\"evidence\":[\"official source\"]}',now(),now()+interval '1 day')",
          );
          let calls = 0;
          const resolvePlace = async (id) => {
            calls++;
            return {
              id,
              facts: {
                openingHours: {
                  value: "09:00-17:00",
                  sourceUrl: "https://example.org/official",
                },
              },
              source_url: "https://www.openstreetmap.org/",
            };
          };
          await assert.rejects(
            journeyPlaceDetail({
              query: f.query,
              resolvePlace,
              sessionId: id,
              userId: f.users.other.id,
              placeId: "p1",
            }),
            (e) => e.status === 404,
          );
          assert.equal(calls, 0);
          const detail = await journeyPlaceDetail({
            query: f.query,
            resolvePlace,
            sessionId: id,
            userId,
            placeId: "p1",
          });
          assert.equal(calls, 1);
          assert.ok(detail.item.facts.openingHours);
          assert.equal(
            detail.hierarchyInference.evidence[0],
            "official source",
          );
          await assert.rejects(
            journeyPlaceDetail({
              query: f.query,
              resolvePlace: async () => {
                throw Object.assign(Error("offline"), { status: 503 });
              },
              sessionId: id,
              userId,
              placeId: "p1",
            }),
            (e) => e.status === 503,
          );
        },
      );
      await t.test(
        "JM07 eight levels preserve hierarchy and source IDs while removing repeated evidence",
        async () => {
          let value = {
            ...point(8),
            hierarchyLevel: 8,
            sourceRecords: [
              { id: "original8", name: "Full source", raw: "x".repeat(1000) },
            ],
          };
          for (let depth = 7; depth >= 1; depth--)
            value = {
              ...point(depth),
              hierarchyLevel: depth,
              parentId: depth === 1 ? null : "p" + (depth - 1),
              hierarchyInference: {
                status: "child",
                method: "containment",
                evidence: "x".repeat(5000),
              },
              children: [value],
            };
          const reduced = (
            await f.query(`SELECT ${scenicSummarySql("$1::jsonb")} AS place`, [
              JSON.stringify(value),
            ])
          ).rows[0].place;
          assert.deepEqual(reduced, scenicSummary(value));
          let last = reduced,
            n = 1;
          while (last.children.length) {
            last = last.children[0];
            n++;
          }
          assert.equal(n, 8);
          assert.equal(last.sourceRecords[0].id, "original8");
          assert.ok(!reduced.hierarchyInference.evidence);
        },
      );
      await t.test(
        "JM04 oversized wished details fail explicitly without removing stored places",
        async () => {
          await f.query(
            "UPDATE journey_sessions SET catalog=jsonb_build_object('a',jsonb_build_object('clusters',jsonb_build_array(jsonb_build_object('id','x','members',jsonb_build_array(jsonb_build_object('id','huge','children','[]'::jsonb,'opening_hours',repeat('x',9000000))))))) WHERE id=$1",
            [id],
          );
          await assert.rejects(
            run(null, { a: ["x"] }, { huge: true }),
            (e) => e.status === 413,
          );
          assert.equal(
            (
              await f.query(
                "SELECT length(catalog->'a'->'clusters'->0->'members'->0->>'opening_hours') n FROM journey_sessions WHERE id=$1",
                [id],
              )
            ).rows[0].n,
            9000000,
          );
        },
      );
      await t.test(
        "JM05 5043-place catalog: restricted-heap worker completes eight planning drafts",
        { timeout: 90000 },
        async () => {
          await f.query(
            `WITH points AS (SELECT jsonb_build_object('id','p'||i,'name','景点'||i,'category','attraction','lat',31+(i%100)*0.0001,'lng',121+(i%70)*0.0001,
        'sourceRecords',jsonb_build_array(jsonb_build_object('name',repeat('地',1000))),
        'children',jsonb_build_array(jsonb_build_object('id','child'||i,'name','子景点'||i,'description',repeat('x',3400),'children','[]'::jsonb))) value FROM generate_series(1,5043)i),
        members AS (SELECT jsonb_agg(value) value FROM points)
        UPDATE journey_sessions SET catalog=jsonb_build_object('a',jsonb_build_object('clusters',jsonb_build_array(jsonb_build_object('id','x','members',members.value)))) FROM members WHERE id=$1`,
            [id],
          );
          const size = (
            await f.query(
              "SELECT octet_length(catalog::text) bytes FROM journey_sessions WHERE id=$1",
              [id],
            )
          ).rows[0].bytes;
          assert.ok(size > 33000000);
          const invoke = (mode) =>
            new Promise((resolve, reject) => {
              let out = "",
                err = "";
              const child = spawn(
                process.execPath,
                [
                  "--max-old-space-size=192",
                  "--max-semi-space-size=8",
                  "test/helpers/journey-heap-worker.mjs",
                  f.schema,
                  id,
                  userId,
                  mode,
                ],
                {
                  env: process.env,
                  windowsHide: true,
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              child.stdout.on("data", (d) => (out += d));
              child.stderr.on("data", (d) => (err += d));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, out, err }));
            });
          const result = await invoke("fixed");
          assert.equal(result.code, 0, result.err);
          const stats = JSON.parse(result.out);
          assert.equal(stats.drafts, 8);
          assert.equal(stats.regularCandidates, 60);
          assert.equal(stats.wishedCandidates, 1);
          console.log(
            "HEAP " + JSON.stringify({ catalogBytes: size, ...stats }),
          );
          const compacted = await compactJourneyCatalogs(f);
          assert.equal(compacted.sessions, 1);
          assert.ok(compacted.afterBytes < compacted.beforeBytes / 4);
          assert.equal(compacted.remaining, 0);
          assert.equal((await compactJourneyCatalogs(f)).sessions, 0);
          const after = await run(null, { a: ["x"] }, { child5000: true });
          assert.equal(after.a.length, 61);
          assert.ok(after.a[0].wanted);
          console.log("COMPACTION " + JSON.stringify(compacted));
          if (process.env.RUN_HEAP_BASELINE === "1") {
            const before = await invoke("before");
            console.log(
              "HEAP baseline " +
                JSON.stringify({
                  code: before.code,
                  heapExhausted: before.err.includes("heap out of memory"),
                  output: before.out,
                }),
            );
          }
        },
      );
    } finally {
      await f.close();
    }
  },
);
