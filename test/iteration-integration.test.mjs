import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { iterationFixture } from "./helpers/iteration-db.mjs";
import { installCityWalkRoutes } from "../server/services/citywalk-service.mjs";
import {
  installClassicWalkRoutes,
  seedClassicWalks,
} from "../server/services/classic-citywalks.mjs";
import { installInboxRoutes } from "../server/operations/inbox.mjs";

test(
  "INT-01 guest → login → walking route → audit → inbox → read → session revocation",
  { skip: process.env.TEST_ITERATION !== "1" },
  async (t) => {
    const f = await iterationFixture({
      schemas: [
        "citywalk-schema.sql",
        "citywalk-expansion-schema.sql",
        "operations/inbox-schema.sql",
      ],
    });
    try {
      const city = {
        id: "fixture-city",
        name: "集成测试城",
        country: "CN",
        lat: 31,
        lng: 121,
      };
      const points = [
        {
          id: "museum",
          name: "博物馆",
          category: "attraction",
          lat: 31,
          lng: 121,
        },
        {
          id: "mall",
          name: "商场",
          category: "shopping",
          lat: 31,
          lng: 121.001,
        },
      ];
      const restaurant = {
        id: "restaurant",
        name: "餐厅",
        category: "food",
        lat: 31.001,
        lng: 121.001,
      };
      await f.query(
        "CREATE TABLE places(id text PRIMARY KEY,name text,country text,province text,lat double precision,lng double precision,timezone text,category text)",
      );
      await f.query(
        "INSERT INTO places VALUES($1,$2,'CN','',31,121,'Asia/Shanghai','city')",
        [city.id, city.name],
      );
      let routeChecks = 0;
      const verify = async (stops) => {
        routeChecks++;
        return {
          status: "verified",
          distanceM: 1250,
          durationSeconds: 1000,
          blocked: false,
          warning: false,
          legs: stops.slice(1).map((p, i) => ({
            from: stops[i].id,
            to: p.id,
            mapPolyline: [
              [stops[i].lng, stops[i].lat],
              [p.lng, p.lat],
            ],
          })),
        };
      };
      installCityWalkRoutes(f.app, {
        ...f,
        loadCity: async () => ({
          city,
          clusters: [{ id: "group", members: points }],
        }),
        nearby: async () => [restaurant],
        verify,
      });
      installClassicWalkRoutes(f.app, { ...f, verify });
      installInboxRoutes(f.app, f);
      await seedClassicWalks(f.query);
      await f.start();
      const count = async (table) =>
        (await f.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
      const before = {
        users: await count("users"),
        events: await count("operation_events"),
        drafts: await count("citywalk_drafts"),
      };
      assert.equal(
        (await f.request("/api/citywalk/classics", { user: null })).data.items
          .length,
        3,
      );
      assert.equal(
        (await f.request("/api/citywalks", { user: null })).status,
        401,
      );
      await f.events.flush();
      assert.deepEqual(
        {
          users: await count("users"),
          events: await count("operation_events"),
          drafts: await count("citywalk_drafts"),
        },
        before,
      );
      const login = await f.request("/api/auth/login", {
        user: null,
        body: { username: f.users.user.username, password: f.password },
      });
      assert.equal(login.status, 200);
      assert.ok(login.headers.get("set-cookie").includes("HttpOnly"));
      f.users.user.cookie = login.headers.get("set-cookie").split(";")[0];
      const ready = async (path, body) => {
        for (let i = 0; i < 80; i++) {
          const r = await f.request(path, { user: "user", body });
          if (r.status !== 202) return r;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw Error("job timeout");
      };
      const draft = (await ready("/api/citywalk/catalog/" + city.id)).data;
      assert.ok(draft.draftId);
      const near = await ready(
        "/api/citywalk/drafts/" + draft.draftId + "/nearby",
        { clusterIds: ["group"], anchorId: "museum" },
      );
      assert.equal(near.status, 200);
      assert.ok(near.data.items.some((p) => p.id === "restaurant"));
      const input = {
        draftId: draft.draftId,
        clusterIds: ["group"],
        stopIds: ["museum", "mall", "restaurant"],
        startId: "museum",
      };
      const preview = await ready("/api/citywalk/preview", input);
      assert.equal(preview.data.route.status, "verified");
      assert.equal(await count("citywalks"), 0);
      const id = randomUUID(),
        saved = await f.request("/api/citywalks", {
          user: "user",
          body: { ...input, id, title: "集成验收路线" },
        });
      assert.equal(saved.status, 200);
      assert.equal(saved.data.distance_m, 1250);
      assert.equal(saved.data.stops.length, 3);
      assert.ok(routeChecks >= 2, "save verifies distance again");
      assert.equal(
        (await f.request("/api/citywalks/" + id, { user: "other" })).status,
        404,
      );
      while (f.events.stats().queued) await f.events.flush();
      const audit = await f.request(
        "/api/admin/events?userId=" + f.users.user.id,
      );
      assert.equal(audit.status, 200);
      assert.ok(
        audit.data.items.some(
          (e) => e.action === "POST /api/citywalks" && e.status === 200,
        ),
      );
      assert.ok(audit.data.items.every((e) => e.user_id === f.users.user.id));
      assert.equal(
        (await f.request("/api/admin/events", { user: "user" })).status,
        403,
      );
      const message = {
        id: randomUUID(),
        title: "路线已保存",
        body: "集成验收消息，不发送外部邮件。",
        audience: "selected",
        recipientIds: [f.users.user.id],
      };
      assert.equal(
        (await f.request("/api/admin/messages", { body: message })).status,
        201,
      );
      const recipients = (
        await f.request("/api/admin/messages/" + message.id + "/preview")
      ).data;
      const sent = await f.request(
        "/api/admin/messages/" + message.id + "/send",
        {
          body: {
            version: recipients.version,
            recipientCount: recipients.eligibleRecipients,
            confirmation: "send",
          },
        },
      );
      assert.equal(sent.status, 200);
      assert.equal(sent.data.recipient_count, 1);
      const inbox = (await f.request("/api/me/messages", { user: "user" }))
        .data;
      assert.equal(inbox.unread, 1);
      assert.equal(
        (await f.request("/api/me/messages", { user: "other" })).data.items
          .length,
        0,
      );
      assert.equal(
        (
          await f.request("/api/me/messages/" + inbox.items[0].id + "/read", {
            user: "user",
            body: {},
          })
        ).status,
        200,
      );
      assert.equal(
        (await f.request("/api/me/messages", { user: "user" })).data.unread,
        0,
      );
      while (f.events.stats().queued) await f.events.flush();
      const exported = await f.request("/api/admin/events/export"),
        text = gunzipSync(exported.data).toString();
      assert.equal(exported.status, 200);
      assert.ok(text.includes("message.send"));
      assert.ok(text.includes("POST /api/citywalks"));
      for (const secret of [
        f.password,
        f.users.user.cookie,
        "集成验收消息",
        "集成验收路线",
      ])
        assert.equal(text.includes(secret), false);
      assert.equal(
        (
          await f.request(
            "/api/admin/users/" + f.users.user.id + "/sessions/revoke",
            { body: { confirmation: "revoke", reason: "requested" } },
          )
        ).status,
        200,
      );
      assert.equal(
        (await f.request("/api/citywalks/" + id, { user: "user" })).status,
        401,
      );
      assert.equal(
        await count("citywalks"),
        1,
        "revoking a session preserves saved data",
      );
      t.diagnostic(
        JSON.stringify({
          chain: "guest/login/walk/audit/inbox/read/revoke",
          externalCalls: 0,
          productionAccess: false,
        }),
      );
    } finally {
      await f.close();
    }
  },
);
