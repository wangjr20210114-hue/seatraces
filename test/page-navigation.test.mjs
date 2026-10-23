/* 验证页面导航与返回。 */

import test from "node:test";
import assert from "node:assert/strict";
import { createPageNavigation } from "../public/page-navigation.js";
test("personal links share navigation history and direct details return to their own list", () => {
  const before = Object.fromEntries(
    ["window", "document", "location", "history"].map((k) => [
      k,
      globalThis[k],
    ]),
  );
  const handlers = {},
    renders = [];
  let index = 0,
    entries = [{ hash: "#/settings", state: null }];
  globalThis.location = { hash: entries[0].hash };
  globalThis.window = { addEventListener: (k, v) => (handlers[k] = v) };
  globalThis.document = { addEventListener: (k, v) => (handlers[k] = v) };
  globalThis.history = {
    get state() {
      return entries[index].state;
    },
    replaceState(state, unused, hash) {
      entries[index] = { state, hash };
      location.hash = hash;
    },
    pushState(state, unused, hash) {
      entries = entries.slice(0, index + 1);
      entries.push({ state, hash });
      index++;
      location.hash = hash;
    },
    back() {
      index--;
      location.hash = entries[index].hash;
      handlers.popstate();
    },
  };
  try {
    const nav = createPageNavigation({
      onChange: (r) => renders.push(r.path),
      onRepeat() {},
    });
    nav.start();
    let prevented = false;
    const link = {
      target: "",
      hasAttribute: () => false,
      getAttribute: () => "#/security",
    };
    handlers.click({
      button: 0,
      target: { closest: () => link },
      preventDefault() {
        prevented = true;
      },
    });
    assert.ok(prevented);
    assert.equal(history.state.seatracesPage.depth, 1);
    assert.equal(renders.at(-1), "/security");
    nav.back();
    assert.equal(renders.at(-1), "/settings");
    handlers.click({
      button: 0,
      ctrlKey: true,
      target: { closest: () => link },
      preventDefault() {
        throw Error("modified link should remain native");
      },
    });
    entries = [{ hash: "#/favorites/record", state: null }];
    index = 0;
    location.hash = entries[0].hash;
    const direct = createPageNavigation({
      onChange: (r) => renders.push(r.path),
      onRepeat() {},
    });
    direct.start();
    direct.back();
    assert.equal(renders.at(-1), "/favorites");
  } finally {
    for (const [k, v] of Object.entries(before))
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
  }
});
