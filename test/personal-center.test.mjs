import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { iterationFixture } from "./helpers/iteration-db.mjs";
import { installPersonalCenter } from "../server/services/personal-center.mjs";
test(
  "personal center ownership, bounded reads, explicit preferences and account security",
  { skip: process.env.TEST_PERSONAL !== "1" },
  async (t) => {
    const f = await iterationFixture({
      schemas: [
        "schema.sql",
        "citywalk-schema.sql",
        "discovery-schema.sql",
        "operations/inbox-schema.sql",
        "operations/moderation-schema.sql",
        "agent/schema.sql",
        "social/schema.sql",
      ],
    });
    try {
      installPersonalCenter(f.app, {
        auth: f.auth,
        query: f.query,
        transaction: f.transaction,
      });
      await f.start();
      const u = f.users.user.id,
        other = f.users.other.id,
        p = randomUUID(),
        hidden = randomUUID(),
        third = randomUUID();
      for (const [id, owner, title] of [
        [p, u, "自己的收藏"],
        [hidden, u, "已隐藏"],
        [third, other, "其他人的收藏"],
      ]) {
        await f.query(
          "INSERT INTO posts(id,user_id,title,body,snapshot) VALUES($1,$2,$3,'正文',$4)",
          [
            id,
            owner,
            title,
            JSON.stringify({
              days: [{ city: "上海", stops: [{ name: "外滩" }] }],
            }),
          ],
        );
        await f.query(
          "INSERT INTO reactions(user_id,post_id,kind) VALUES($1,$2,'save')",
          [owner, id],
        );
        await f.query(
          "INSERT INTO browse_events(user_id,post_id,dwell_seconds) VALUES($1,$2,10)",
          [owner, id],
        );
      }
      await f.query("UPDATE posts SET hidden_at=now() WHERE id=$1", [hidden]);
      await f.query(
        "INSERT INTO trips(id,user_id,title,request,plan,status) VALUES($1,$2,'计划','{}',$3,'completed'),($4,$2,'计划中','{}','{}','planned')",
        [
          randomUUID(),
          u,
          JSON.stringify({
            cities: [{ name: "上海" }],
            days: [{ stops: [{ name: "外滩" }, { name: "博物馆" }] }],
          }),
          randomUUID(),
        ],
      );
      await f.query(
        "INSERT INTO user_place_presence(user_id,place_id,observed_at,dwell_seconds) VALUES($1,'actual',now(),600)",
        [u],
      );
      await t.test(
        "guests rejected; summary and libraries scoped to caller",
        async () => {
          for (const path of [
            "/api/me/overview",
            "/api/me/report",
            "/api/me/library/favorites",
            "/api/me/style",
            "/api/me/security",
          ])
            assert.equal((await f.request(path, { user: null })).status, 401);
          const summary = await f.request("/api/me/overview", { user: "user" });
          assert.equal(summary.status, 200);
          assert.equal(summary.data.trips, 2);
          assert.equal(summary.data.favorites, 1);
          assert.equal(summary.data.browsing, 1);
          const rows = await f.request("/api/me/library/favorites", {
            user: "user",
          });
          assert.deepEqual(
            rows.data.items.map((p) => p.id),
            [p],
          );
          assert.equal(rows.data.items[0].user_id, u);
          assert.equal(typeof rows.data.items[0].nickname, 'string');
          assert.ok(rows.data.items[0].created_at && rows.data.items[0].saved_at);
          assert.equal(rows.data.items[0].day_count, 1);
          assert.equal(rows.data.items[0].excerpt, '正文');
          assert.ok(!('snapshot' in rows.data.items[0]), 'library must not copy full itineraries');
          const browsing = await f.request('/api/me/library/browsing', { user:'user' });
          assert.equal(browsing.data.items[0].dwell_seconds, 10);
          assert.equal(browsing.data.items[0].record_days, 1);
          assert.equal(
            (
              await f.request("/api/me/library/favorites/" + third, {
                user: "user",
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await f.request("/api/me/library/favorites/" + hidden, {
                user: "user",
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await f.request("/api/me/library/browsing/" + p, {
                user: "other",
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await f.request("/api/me/library/favorites?limit=100000", {
                user: "user",
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await f.request("/api/me/library/favorites?offset=-1", {
                user: "user",
              })
            ).status,
            400,
          );
          assert.equal(
            (await f.request("/api/me/library/sql", { user: "user" })).status,
            400,
          );
        },
      );
      await t.test(
        "report counts actual presence separately from planned stops and handles empty plans",
        async () => {
          const r = await f.request("/api/me/report", { user: "user" });
          assert.equal(r.status, 200);
          assert.equal(r.data.completed, 1);
          assert.equal(r.data.planned, 1);
          assert.equal(r.data.stops, 2);
          assert.equal(r.data.visitedPlaces, 1);
          assert.deepEqual(r.data.cities, ["上海"]);
          const empty = await f.request("/api/me/report", { user: "other" });
          assert.equal(empty.data.completed, 0);
          assert.equal(empty.data.visitedPlaces, 0);
        },
      );
      await t.test(
        "preference edits persist in agent memory with optimistic concurrency",
        async () => {
          const r = await f.request("/api/me/style", { user: "user" });
          assert.equal(r.status, 200);
          const body = {
            values: { pace: "relaxed", interests: ["建筑"] },
            versions: r.data.versions,
          };
          assert.equal(
            (
              await f.request("/api/me/style", {
                user: "user",
                method: "PUT",
                body,
              })
            ).status,
            200,
          );
          assert.equal(
            (
              await f.request("/api/me/style", {
                user: "user",
                method: "PUT",
                body,
              })
            ).status,
            409,
          );
          const updated = await f.request("/api/me/style", { user: "user" });
          assert.equal(updated.data.values.pace, "relaxed");
          assert.deepEqual(updated.data.values.interests, ["建筑"]);
          assert.equal(
            (
              await f.request("/api/me/style", {
                user: "user",
                method: "PUT",
                body: { values: { role: "admin" }, versions: {} },
              })
            ).status,
            400,
          );
          assert.equal(
            (await f.request("/api/me/style", { user: "other" })).data.values
              .pace,
            "balanced",
          );
        },
      );
      await t.test(
        "removing own favorite does not delete publication or other users data",
        async () => {
          assert.equal(
            (
              await f.request("/api/me/library/favorites/" + third, {
                user: "user",
                method: "DELETE",
              })
            ).status,
            200,
          );
          assert.equal(
            (await f.request("/api/me/library/favorites", { user: "other" }))
              .data.items.length,
            1,
          );
          await f.request("/api/me/library/favorites/" + p, {
            user: "user",
            method: "DELETE",
          });
          assert.equal(
            (await f.query("SELECT 1 FROM posts WHERE id=$1", [p])).rowCount,
            1,
          );
        },
      );
      await t.test(
        "200 parallel overview requests are bounded and isolated",
        async () => {
          let next = 0;
          const times = [];
          await Promise.all(
            Array.from({ length: 12 }, async () => {
              while (next++ < 200) {
                const start = performance.now(),
                  r = await f.request("/api/me/overview", { user: "user" });
                assert.equal(r.status, 200);
                assert.equal(r.data.trips, 2);
                times.push(performance.now() - start);
              }
            }),
          );
          times.sort((a, b) => a - b);
          t.diagnostic(
            JSON.stringify({
              requests: 200,
              concurrency: 12,
              p95Ms: Math.round(times[189]),
            }),
          );
        },
      );
      await t.test(
        "session revocation requires password and preserves current login",
        async () => {
          const before = await f.request("/api/me/security", { user: "user" });
          assert.equal(before.status, 200);
          assert.equal(
            (
              await f.request("/api/auth/revoke-other-sessions", {
                user: "user",
                body: { password: "wrong-password" },
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await f.request("/api/auth/revoke-other-sessions", {
                user: "user",
                body: { password: f.password },
              })
            ).status,
            200,
          );
          assert.equal(
            (await f.request("/api/me/security", { user: "user" })).status,
            200,
          );
        },
      );
      await t.test(
        "password change rotates session and never grants privileges",
        async () => {
          assert.equal(
            (
              await f.request("/api/auth/change-password", {
                user: "user",
                body: {
                  currentPassword: "wrong-password",
                  newPassword: "Another-Password!",
                },
              })
            ).status,
            400,
          );
          const r = await f.request("/api/auth/change-password", {
            user: "user",
            body: {
              currentPassword: f.password,
              newPassword: "Another-Password!",
            },
          });
          assert.equal(r.status, 200);
          assert.ok(r.headers.get("set-cookie")?.includes("HttpOnly"));
          assert.equal(
            (await f.request("/api/me/security", { user: "user" })).status,
            401,
          );
          assert.equal(
            (await f.query("SELECT role FROM users WHERE id=$1", [u])).rows[0]
              .role,
            "user",
          );
          assert.equal(
            (
              await f.request("/api/auth/login", {
                user: null,
                body: { username: f.users.user.username, password: f.password },
              })
            ).status,
            401,
          );
          assert.equal(
            (
              await f.request("/api/auth/login", {
                user: null,
                body: {
                  username: f.users.user.username,
                  password: "Another-Password!",
                },
              })
            ).status,
            200,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
