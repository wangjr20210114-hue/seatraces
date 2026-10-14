import { currentPosition } from "./geolocation.js";

export function createPresenceRecorder({ getTrip, api, onState }) {
  let enabled = false,
    busy = false,
    samples = [],
    context = "",
    generation = 0;
  const recorded = new Set();
  const today = (timezone) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  async function tick(interactive = false) {
    if (!enabled || busy || document.visibilityState !== "visible") return;
    const trip = getTrip(),
      day = trip?.plan.days.find((d) => d.date === today(d.timezone));
    const key = trip && day ? trip.id + ":" + day.date : "";
    if (context !== key) {
      samples = [];
      context = key;
    }
    if (!key || !day.stops.length) return;
    busy = true;
    const run = generation;
    try {
      const p = await currentPosition({
        detailed: true,
        passive: !interactive,
      });
      if (
        !enabled ||
        generation !== run ||
        document.visibilityState !== "visible" ||
        getTrip()?.id !== trip.id
      )
        return;
      if (
        !Number.isFinite(p.accuracy) ||
        p.accuracy <= 0 ||
        p.accuracy > 60 ||
        !Number.isFinite(p.at)
      ) {
        samples = [];
        return;
      }
      if (
        samples.length &&
        (p.at - samples.at(-1).at > 120000 || p.at <= samples.at(-1).at)
      )
        samples = [];
      samples.push(p);
      samples = samples.filter((s) => s.at >= p.at - 12 * 60000).slice(-16);
      if (samples.length < 6 || p.at - samples[0].at < 600000) return;
      const r = await api(`/api/journey/trips/${trip.id}/presence`, {
        samples,
      });
      for (const o of r.observations)
        if (!recorded.has(key + o.placeId)) {
          recorded.add(key + o.placeId);
          onState(true, "已记下这处停留");
        }
    } catch (e) {
      if (generation === run) {
        enabled = false;
        samples = [];
        onState(false, interactive ? e.message : "到访记录已暂停，可重新开启");
      }
    } finally {
      busy = false;
    }
  }
  document.addEventListener("visibilitychange", () => {
    generation++;
    samples = [];
    if (document.visibilityState === "visible") tick();
  });
  setInterval(() => tick(), 60000);
  return {
    isEnabled: () => enabled,
    async toggle() {
      enabled = !enabled;
      generation++;
      samples = [];
      context = "";
      onState(
        enabled,
        enabled
          ? "仅旅行当天前台记录；停留约 10 分钟后推断到访"
          : "已暂停到访记录",
      );
      if (enabled) await tick(true);
    },
  };
}
