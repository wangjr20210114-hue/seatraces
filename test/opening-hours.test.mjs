import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  openingOnDate,
  validateOpeningDate,
} from "../server/opening-hours.mjs";
import {
  travelInformation,
  factValue,
  safeSourceUrl,
} from "../public/place-information.js";
const place = {
  id: "osm:node/1",
  country: "JP",
  source_timestamp: "2026-10-09T20:21:04Z",
  source_url: "https://www.openstreetmap.org/node/1",
};
const parse = (rule, date = "2026-10-12", extra = {}) =>
  openingOnDate({ ...place, opening_hours: rule, ...extra }, date);
const spans = (result) => result.intervals.map((x) => [x.start, x.end]);
test("opening calendar validates dates and leap days before parsing", () => {
  assert.equal(validateOpeningDate("2028-02-29"), "2028-02-29");
  for (const date of [
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "1999-12-31",
    "2100-01-01",
    "2026-10-12T09:00",
    undefined,
  ])
    assert.throws(() => validateOpeningDate(date), { status: 400 });
});
test("split opening hours retain lunch closure and weekday exceptions", async () => {
  assert.deepEqual(spans(await parse("Mo-Fr 09:00-12:00,13:00-17:00")), [
    ["09:00", "12:00"],
    ["13:00", "17:00"],
  ]);
  assert.equal((await parse("Mo-Su 09:00-17:00; Mo off")).dayState, "closed");
  assert.deepEqual(
    spans(await parse("Mo-Fr 09:00-17:00; We 10:00-12:00", "2026-10-14")),
    [["10:00", "12:00"]],
  );
});
test("overnight hours carry over from the previous weekday and stop at closing", async () => {
  assert.deepEqual(spans(await parse("Fr 22:00-02:00", "2026-10-16")), [
    ["22:00", "24:00"],
  ]);
  assert.deepEqual(spans(await parse("Fr 22:00-02:00", "2026-10-17")), [
    ["00:00", "02:00"],
  ]);
  assert.equal(
    (await parse("Fr 22:00-02:00", "2026-10-18")).dayState,
    "closed",
  );
});
test("seasonal rules are evaluated for the requested local calendar day", async () => {
  assert.deepEqual(
    spans(await parse("Apr-Oct 09:00-18:00; Nov-Mar 10:00-16:00")),
    [["09:00", "18:00"]],
  );
  assert.deepEqual(
    spans(
      await parse("Apr-Oct 09:00-18:00; Nov-Mar 10:00-16:00", "2026-11-12"),
    ),
    [["10:00", "16:00"]],
  );
});
test("24/7 and missing data have distinct outcomes", async () => {
  assert.deepEqual(spans(await parse("24/7")), [["00:00", "24:00"]]);
  for (const value of [null, "", undefined]) {
    const r = await parse(value);
    assert.equal(r.status, "missing");
    assert.equal(r.dayState, "unknown");
  }
});
test("uncertain and appointment rules never expose guessed times as confirmed hours", async () => {
  for (const rule of ["09:00+", '"by appointment"']) {
    const r = await parse(rule);
    assert.equal(r.dayState, "uncertain");
    assert.equal(r.referenceOnly, true);
    assert.ok(
      r.intervals.every((x) => x.unknown && x.start === null && x.end === null),
    );
  }
});
test("unverified holiday or solar context remains unknown", async () => {
  for (const rule of [
    "Mo-Su 09:00-17:00; PH off",
    "SH 10:00-14:00",
    "sunrise-sunset",
    "easter off",
  ])
    assert.equal((await parse(rule)).status, "needs_context");
  assert.equal(
    (await parse('09:00-17:00 "PH information at desk"')).status,
    "parsed",
  );
});
test("malformed rules remain explicit and do not mean closed", async () => {
  assert.equal((await parse("Mo 99:90-100:00")).status, "unparseable");
  assert.equal((await parse("x".repeat(2001))).dayState, "unknown");
});
test("OSM provenance, cached status and editorial qualifications survive parsing", async () => {
  const editorial = {
    value: "仅 10 月 11 日开放至 23:00",
    source: "官方网站",
    sourceTimestamp: "2026-10-11",
  };
  const r = await parse("09:00-17:00", "2026-10-12", {
    cacheStatus: "snapshot",
    cachedAt: "2026-10-10T00:00:00Z",
    facts: { openingHours: editorial },
  });
  assert.deepEqual(spans(r), [["09:00", "17:00"]]);
  assert.deepEqual(r.editorialNote, editorial);
  assert.equal(r.sourceTimestamp, place.source_timestamp);
  assert.equal(r.timeZone, "Asia/Tokyo");
  assert.equal(r.cacheStatus, "snapshot");
});
test("host timezone and its DST jump cannot shift the place calendar hours", async () => {
  const script =
    "import {openingOnDate} from './server/opening-hours.mjs'; console.log(JSON.stringify(await openingOnDate({opening_hours:'Su 01:00-04:00',country:'JP'},'2026-03-08')));";
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, TZ: "America/New_York" },
      windowsHide: true,
    },
  );
  assert.deepEqual(spans(JSON.parse(stdout)), [["01:00", "04:00"]]);
});
test("accommodation information gaps exclude scenic ticket and last-entry fields", () => {
  const r = travelInformation({
    category: "accommodation",
    facts: {
      checkIn: { value: "14:00", status: "source_reported" },
      checkOut: { value: null, status: "unknown" },
      phone: { value: "123", status: "source_reported" },
    },
  });
  assert.equal(r.knownCount, 2);
  assert.ok(r.missing.includes("checkOut"));
  assert.ok(!r.fields.includes("ticketPrice"));
  assert.equal(factValue("fee", "yes"), "有收费标注，金额与适用范围待核实");
  assert.equal(factValue("ticketPrice", null), "");
});
test("unsafe source links are excluded without obscuring ordinary source URLs", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:password@example.com/",
    "file:///tmp/x",
  ])
    assert.equal(safeSourceUrl(url), null);
  assert.equal(safeSourceUrl(place.source_url), place.source_url);
});
