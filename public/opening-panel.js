import { placeTimeZone } from "./travel-time.js";
import { safeSourceUrl, knownFact } from "./place-information.js";
export function mountOpeningPanel(host, place, api) {
  if (
    !knownFact(place.facts?.openingHours) &&
    !(!place.facts?.openingHours && place.opening_hours)
  )
    return;
  const section = document.createElement("section");
  section.className = "opening-panel";
  section.innerHTML =
    '<h4>查看某天开放时段</h4><form class="opening-form"><label>到访日期（地点当地）<input type="date" min="2000-01-01" max="2099-12-31" required></label><button class="btn light small" type="submit">查看开放时段</button></form><div class="opening-result" role="status">优先采用已核对的官方常规规则。</div>';
  host.append(section);
  const zone = placeTimeZone(place),
    input = section.querySelector("input"),
    result = section.querySelector(".opening-result");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      ...(zone ? { timeZone: zone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  input.value = `${parts.year}-${parts.month}-${parts.day}`;
  let requestId = 0;
  const line = (text, className = "") => {
    const p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    result.append(p);
    return p;
  };
  input.addEventListener("change", () => {
    requestId++;
    result.textContent = "日期已更改，请重新查看开放时段。";
  });
  section.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const seq = ++requestId,
      date = input.value;
    result.textContent = "正在解析此日开放规则…";
    try {
      const value = await api(
        "/catalog/opening?" + new URLSearchParams({ id: place.id, date }),
      );
      if (seq !== requestId || !section.isConnected) return;
      result.replaceChildren();
      line(
        `${value.date} · ${value.timeZone || "地点当地日期，时区未确认"}`,
        "small muted",
      );
      for (const interval of value.regularIntervals || [])
        line(
          "官方常规时段：" + interval.start + " — " + interval.end,
          "opening-interval",
        );
      if (value.status !== "parsed")
        line(value.message || "无法确认此日开放时段。");
      else {
        line(
          value.dayState === "closed"
            ? "按此规则，当天无开放时段"
            : value.dayState === "uncertain"
              ? "此日包含不确定时段，请联系地点确认"
              : "按来源规则推算的开放时段",
          "opening-title",
        );
        for (const interval of value.intervals) {
          line(
            interval.unknown
              ? "存在未确认时段（不使用推测的结束时间）"
              : `${interval.start} — ${interval.end}`,
            "opening-interval",
          );
          if (interval.comment) line(interval.comment, "small muted");
        }
        if (value.warnings?.length) {
          const detail = document.createElement("details"),
            summary = document.createElement("summary");
          summary.textContent =
            "规则有 " + value.warnings.length + " 条解析提示，需核对原文";
          detail.append(summary);
          for (const warning of value.warnings) {
            const p = document.createElement("p");
            p.textContent = warning;
            detail.append(p);
          }
          result.append(detail);
        }
      }
      if (value.editorialNote)
        line(
          "另有补充来源说明：" +
            String(value.editorialNote.value) +
            "。以上推算仍依据 OSM，不能替代补充说明的日期或适用范围。",
          "opening-note",
        );
      if (value.cacheStatus === "snapshot")
        line("使用缓存来源，最后成功查询：" + value.cachedAt, "opening-note");
      if (value.raw) line("来源原文：" + value.raw, "small muted");
      line(value.notice, "small muted");
      if (value.sourceTimestamp)
        line("来源快照：" + value.sourceTimestamp, "small muted");
      const url = safeSourceUrl(value.sourceUrl);
      if (url) {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "查看官方或原始来源 ↗";
        result.append(a);
      }
    } catch (error) {
      if (seq === requestId && section.isConnected)
        result.textContent = error.message;
    }
  });
}
