import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
test(
  "journey sessions enforce ownership and validate before provider calls",
  { skip: !process.env.TEST_URL },
  async () => {
    const base = process.env.TEST_URL;
    function client() {
      let cookie = "";
      return async (path, body) => {
        const r = await fetch(base + "/api" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            "X-Seatraces": "1",
            "Content-Type": "application/json",
            Cookie: cookie,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (r.headers.get("set-cookie"))
          cookie = r.headers.get("set-cookie").split(";")[0];
        return { status: r.status, data: await r.json() };
      };
    }
    const a = client(),
      b = client(),
      anon = client();
    for (const c of [a, b])
      assert.equal(
        (
          await c("/auth/register", {
            username: "journey_" + randomBytes(5).toString("hex"),
            password: randomBytes(16).toString("hex"),
          })
        ).status,
        200,
      );
    const request = {
      origin: { label: "上海" },
      cityIds: ["suzhou"],
      start: "2026-11-12",
      end: "2026-11-13",
    };
    assert.equal((await anon("/journey/sessions", request)).status, 401);
    assert.equal(
      (
        await a("/journey/sessions", {
          ...request,
          cityIds: Array(6).fill("suzhou"),
        })
      ).status,
      400,
    );
    const session = await a("/journey/sessions", request);
    assert.equal(session.status, 201);
    const path = "/journey/sessions/" + session.data.id;
    assert.equal((await b(path + "/questions", {})).status, 404);
    assert.equal((await b(path + "/cities/suzhou", {})).status, 404);
    assert.equal(
      (await b(path + "/wishes", { placeId: "outside", wanted: true })).status,
      404,
    );
    assert.equal(
      (await a(path + "/wishes", { placeId: "outside", wanted: true })).status,
      400,
    );
    assert.equal((await a(path + "/cities/hangzhou", {})).status, 400);
    assert.equal(
      (await a(path + "/visits", { placeId: "osm:node/1", visited: true }))
        .status,
      400,
    );
    assert.equal(
      (
        await a(path + "/generate", {
          selections: { suzhou: ["invented"] },
          answers: {},
        })
      ).status,
      400,
    );
    const questions = await a(path + "/questions", {});
    assert.equal(questions.status, 200);
    assert.ok(questions.data.questions.some((q) => q.id === "crowd"));
    assert.ok(questions.data.questions.some((q) => q.id === "revisit"));
  },
);
