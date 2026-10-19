import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
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
    const restored=await a(path);
    assert.equal(restored.status,200);assert.equal(restored.data.id,session.data.id);
    assert.deepEqual(restored.data.request.cityIds,request.cityIds);
    assert.equal(Object.hasOwn(restored.data,'catalog'),false);
    assert.equal((await b(path)).status,404);assert.equal((await anon(path)).status,401);
    const clientSessionId=randomUUID();
    const retries=await Promise.all(Array.from({length:6},()=>a('/journey/sessions',{...request,clientSessionId})));
    assert.equal(retries.filter(r=>r.status===201).length,1);
    assert.ok(retries.every(r=>[200,201].includes(r.status)&&r.data.id===clientSessionId));
    assert.equal((await a('/journey/sessions',{...request,clientSessionId,origin:{label:'北京'}})).status,409);
    assert.equal((await b('/journey/sessions',{...request,clientSessionId})).status,409);
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
    assert.ok(questions.data.questions.some((q) => q.id === 'companion'));
    const contextual=await a(path+'/questions',{answers:{companion:'family',visitedNames:['外滩']}});
    assert.ok(contextual.data.questions.some(q=>q.id==='crowd'));
    assert.ok(contextual.data.questions.some(q=>q.id==='revisit'));
    assert.equal(contextual.data.questions.some(q=>q.id==='companion'),false);
  },
);
