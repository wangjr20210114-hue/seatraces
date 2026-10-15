import { uniqueCities } from "./city-selection.js";
import { orderWalk, walkName, metres } from "./citywalk-route.js";
import { schematicConnections } from "./route-curves.js";
import { mainlandEligible, toGcj } from "./coordinates.js";
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const categoryLabel = (p) =>
  ({
    food: "餐饮",
    shopping: "购物",
    heritage: "人文",
    nature: "自然",
    leisure: "休闲",
    attraction: "游览",
  })[p.category] || "游览";
export async function renderWalkEditor({
  route,
  content,
  setTitle,
  api,
  navigate,
  isCurrent,
  toast,
}) {
  let disposed = false,
    stage = 0,
    revision = 0,
    searchRevision = 0,
    timer,
    frame,
    selected = new Map(),
    pool = new Map(),
    city,
    data,
    group,
    previous;
  let id = crypto.randomUUID(),
    version = null,
    title = "",
    startId = "",
    anchorId = "",
    verified = null,
    busy = false,
    saving = false,
    filter = "",
    nearbySequence = 0,
    notice = "";
  const current = () => !disposed && isCurrent(),
    $ = (s) => content.querySelector(s),
    position = (p) =>
      mainlandEligible(p) ? toGcj(p).split(",").map(Number) : [p.lng, p.lat];
  const ordered = () =>
    orderWalk([...selected.values()], startId).map((p) => ({
      ...p,
      name: walkName(p),
    }));
  const fail = (e) => {
    if (current()) {
      const el = $("#walk-error");
      if (el) el.textContent = e.message;
      else toast(e.message);
    }
  };
  const steps = (n) =>
    `<div class="walk-steps">${["选城市", "选步行圈", "连成路线"].map((s, i) => `<span class="${i === n ? "active" : ""}">${i + 1} ${s}</span>`).join("")}</div>`;
  async function poll(url, body, valid = current) {
    for (let i = 0; i < 120; i++) {
      const r = await api(url, body);
      if (!valid()) return null;
      if (r.status !== "loading") return r;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(r.retryAfterMs || 1500, 2000)),
      );
    }
    throw Error("地点或步行路线仍在准备，请稍后再试");
  }
  function mapMessage(e) {
    if (
      !current() ||
      e.origin !== location.origin ||
      e.source !== frame?.contentWindow
    )
      return;
    if (e.data?.type === "seatraces-map-ready") paintMap();
    if (e.data?.type === "seatraces-service-pick") void toggle(e.data.id);
  }
  window.addEventListener("message", mapMessage);
  const cleanup = () => {
    disposed = true;
    revision++;
    nearbySequence++;
    clearTimeout(timer);
    window.removeEventListener("message", mapMessage);
  };
  setTitle(version ? "编辑 CityWalk" : "我的 CityWalk");
  function cityPage() {
    if (saving) return;
    busy = false;
    stage = 0;
    revision++;
    nearbySequence++;
    frame = null;
    content.innerHTML = `<div class="walk-editor">${steps(0)}<div class="walk-intro"><h2>今天，逛哪座城？</h2></div><label class="walk-label" for="walk-city-query">城市</label><input id="walk-city-query" placeholder="搜索城市，如上海" autocomplete="off"><div class="choices" id="walk-city-options"></div><p class="error" id="walk-error" role="alert"></p></div>`;
    async function search(q, seq) {
      try {
        const rows = uniqueCities(
          await api("/api/places?category=city&q=" + encodeURIComponent(q)),
          18,
        );
        if (!current() || stage !== 0 || seq !== searchRevision) return;
        $("#walk-city-options").innerHTML = rows
          .map(
            (c, i) =>
              `<button class="choice" data-city="${i}">${esc(c.name)}<small>${esc(c.province || c.country)}</small></button>`,
          )
          .join("");
        $("#walk-city-options").onclick = (e) => {
          const b = e.target.closest("[data-city]");
          if (b) {
            previous = null;
            selected.clear();
            void load(rows[Number(b.dataset.city)]);
          }
        };
      } catch (e) {
        fail(e);
      }
    }
    $("#walk-city-query").oninput = (e) => {
      clearTimeout(timer);
      const q = e.target.value,
        seq = ++searchRevision;
      timer = setTimeout(() => void search(q, seq), 250);
    };
    void search("", ++searchRevision);
  }
  async function load(c) {
    city = c;
    stage = 1;
    const own = ++revision;
    frame = null;
    content.innerHTML = `<div class="walk-editor">${steps(1)}<div class="walk-loading"><span class="walk-spin">〰</span><h2>找一片好逛的${esc(c.name)}</h2></div><p class="error" id="walk-error" role="alert"></p><button class="walk-create" id="walk-city-back">换座城市</button></div>`;
    $("#walk-city-back").onclick = cityPage;
    try {
      const r = await poll(
        "/api/citywalk/catalog/" + encodeURIComponent(c.id),
        undefined,
        () => current() && own === revision,
      );
      if (!r) return;
      data = r;
      if (!data.clusters) throw Error("没有可用的步行圈");
      if (previous) {
        const g =
          data.clusters.find((g) =>
            g.members.some((p) => selected.has(p.id)),
          ) || data.clusters[0];
        if (g) {
          begin(g, true);
          return;
        }
      }
      areas();
    } catch (e) {
      if (own !== revision) return;
      fail(e);
      const b = document.createElement("button");
      b.className = "primary";
      b.textContent = "重试";
      b.onclick = () => void load(c);
      content.append(b);
    }
  }
  function areas() {
    if (saving) return;
    busy = false;
    stage = 1;
    revision++;
    nearbySequence++;
    frame = null;
    let shown = 24;
    content.innerHTML = `<div class="walk-editor">${steps(1)}<div class="walk-intro"><h2>${esc(city.name)}，从这一片开始</h2></div><div id="walk-areas" class="walk-cluster-list"></div><button id="walk-area-more" class="loadmore">更多步行圈 ↓</button><p class="error" id="walk-error" role="alert"></p><button class="walk-create" id="walk-city-back">换座城市</button></div>`;
    const paint = () => {
      const all = data.clusters.slice(0, shown);
      $("#walk-areas").innerHTML =
        all
          .map(
            (g) =>
              `<button class="walk-cluster" data-area="${esc(g.id)}"><span>${g.number}</span><div><b>${esc(g.name)}</b><p class="area-route">${
                g.suggestedStopIds
                  ?.map((id) => g.members.find((p) => p.id === id)?.name)
                  .filter(Boolean)
                  .slice(0, 3)
                  .map(esc)
                  .join(" → ") || ""
              }</p></div><small>${g.memberCount} 处</small></button>`,
          )
          .join("") || '<p class="walk-prompt">这里暂时没有相邻的可逛地点</p>';
      $("#walk-area-more").hidden = shown >= data.clusters.length;
    };
    $("#walk-areas").onclick = (e) => {
      const b = e.target.closest("[data-area]");
      if (b) begin(data.clusters.find((g) => g.id === b.dataset.area));
    };
    $("#walk-area-more").onclick = () => {
      shown += 24;
      paint();
    };
    $("#walk-city-back").onclick = cityPage;
    paint();
  }
  function begin(g, restore = false) {
    busy = false;
    verified = null;
    group = g;
    stage = 2;
    revision++;
    nearbySequence++;
    pool = new Map(g.members.map((p) => [p.id, p]));
    if (!restore) {
      selected.clear();
      startId = "";
      anchorId = "";
      verified = null;
      title = city.name + " · " + g.name;
    } else {
      for (const p of selected.values()) pool.set(p.id, p);
      anchorId = selected.keys().next().value || "";
    }
    notice = "";
    content.innerHTML = `<div class="walk-editor">${steps(2)}<div class="walk-intro"><h2>${esc(g.name)}</h2><button class="walk-create" id="walk-area-back">换个步行圈 ↶</button></div><label class="walk-label" for="walk-title">路线名称</label><input id="walk-title" maxlength="80" value="${esc(title)}"><div class="walk-preview walk-edit-map"><iframe id="walk-edit-map" src="/amap-view.html?mode=home&walk=1" title="CityWalk 地图选点"></iframe></div><div id="walk-route-state" class="walk-route-state" role="status"></div><div id="walk-selected"></div><h3>下一站，去这里</h3><label class="walk-label" for="walk-place-query">附近地点</label><input id="walk-place-query" placeholder="搜索附近地点"><p id="walk-nearby-state" role="status"></p><div class="walk-sights" id="walk-candidates"></div><p id="walk-error" class="error" role="alert"></p><div class="walk-save-bar"><b id="walk-count"></b><button id="walk-save" class="primary" disabled>保存路线 ✓</button></div></div>`;
    frame = $("#walk-edit-map");
    $("#walk-title").oninput = (e) => {
      title = e.target.value;
    };
    $("#walk-area-back").onclick = areas;
    $("#walk-place-query").oninput = (e) => {
      filter = e.target.value;
      paintCandidates();
      paintMap();
    };
    $("#walk-candidates").onclick = (e) => {
      const b = e.target.closest("[data-place]");
      if (b) void toggle(b.dataset.place);
    };
    $("#walk-save").onclick = save;
    filter = "";
    paint();
    if (restore) void refreshRoute();
    void loadNearby(anchorId || g.anchor?.id || g.members[0]?.id);
  }
  function candidates() {
    const anchor = pool.get(anchorId);
    return [...pool.values()]
      .filter(
        (p) =>
          !selected.has(p.id) &&
          (!anchor || metres(anchor, p) <= 650) &&
          [p.name, ...(p.aliases || [])].some((n) => n.includes(filter.trim())),
      )
      .sort((a, b) => (anchor ? metres(anchor, a) - metres(anchor, b) : 0))
      .slice(0, 18);
  }
  function paintCandidates() {
    if (stage !== 2 || !current()) return;
    $("#walk-candidates").innerHTML =
      candidates()
        .map(
          (p) =>
            `<button class="walk-sight" data-place="${esc(p.id)}" ${busy || saving ? "disabled" : ""}><span class="walk-check">+</span><span><b>${esc(walkName(p))}</b><small>${categoryLabel(p)}${anchorId ? " · " + Math.round(metres(pool.get(anchorId), p)) + "m" : ""}</small></span></button>`,
        )
        .join("") || '<p class="walk-prompt">附近暂无更多匹配地点</p>';
  }
  function mapCandidates() {
    const chosen = [...selected.values()],
      out = [];
    for (const p of candidates()) {
      if ([...chosen, ...out].every((q) => metres(q, p) >= 35)) out.push(p);
      if (out.length === 10) break;
    }
    return out;
  }
  function paintMap() {
    if (!frame || !current() || stage !== 2) return;
    const stops = ordered().map((p) => ({ ...p, position: position(p) })),
      points = [...selected.values(), ...mapCandidates()].map((p) => ({
        ...p,
        name: (selected.has(p.id) ? "✓ " : "+ ") + walkName(p),
        position: position(p),
        selected: selected.has(p.id),
        saved: selected.has(p.id),
        kind: p.category === "food" ? "dining" : undefined,
      }));
    frame.contentWindow?.postMessage(
      {
        type: "seatraces-route",
        kind: "citywalk",
        contextKey: "walk-edit-" + id,
        view: "day",
        lockView: true,
        fitKey: "walk-" + revision,
        viewPadding: [45, 45, 45, 45],
        focus: position(city),
        stops: [],
        services: points,
        connections:
          verified?.status === "verified"
            ? verified.legs.flatMap((l) => l.paths.map((path) => ({ path })))
            : schematicConnections(stops),
        cities: [],
        cityConnections: [],
        segments: [],
      },
      location.origin,
    );
  }
  function paint() {
    if (!current() || stage !== 2) return;
    const stops = ordered();
    $("#walk-count").textContent = stops.length + " 个地点";
    $("#walk-save").disabled =
      busy ||
      saving ||
      stops.length < 2 ||
      verified?.status !== "verified" ||
      verified.blocked;
    $("#walk-route-state").className =
      "walk-route-state" +
      (busy ? " loading" : "") +
      (verified?.warning ? " warning" : "");
    $("#walk-route-state").textContent = busy
      ? "正在核验步行路线…"
      : notice ||
        (!stops.length
          ? "在地图或列表选择起点"
          : stops.length < 2
            ? "再选一个附近地点"
            : verified?.status === "verified"
              ? "步行 " +
                (verified.distanceM / 1000).toFixed(2) +
                " 公里" +
                (verified.warning ? " · 超过 10 公里，建议分段走" : "")
              : "仅预览 · 步行距离暂未核验");
    $("#walk-selected").innerHTML = stops.length
      ? `<div class="walk-order"><label>从这里出发<select id="walk-start">${stops.map((p) => `<option value="${esc(p.id)}" ${p.id === startId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label><ol>${stops.map((p) => `<li><span>${esc(p.name)}</span><button data-remove="${esc(p.id)}" aria-label="移除${esc(p.name)}" ${saving ? "disabled" : ""}>×</button></li>`).join("")}</ol>${verified?.status === "preview" ? '<button class="walk-create" id="walk-recheck">重新核验 ↻</button>' : ""}</div>`
      : "";
    $("#walk-selected").onclick = (e) => {
      const b = e.target.closest("[data-remove]");
      if (b) void toggle(b.dataset.remove);
    };
    $("#walk-start")?.addEventListener("change", (e) => {
      startId = e.target.value;
      void refreshRoute();
    });
    $("#walk-recheck")?.addEventListener("click", () => void refreshRoute());
    paintCandidates();
    paintMap();
  }
  async function loadNearby(anchor) {
    if (!anchor || !current() || stage !== 2) return;
    const seq = ++nearbySequence,
      valid = () => current() && stage === 2 && seq === nearbySequence;
    $("#walk-nearby-state").textContent = "正在找附近地点…";
    try {
      const r = await poll(
        "/api/citywalk/drafts/" + data.draftId + "/nearby",
        {
          clusterIds: [group.id],
          anchorId: anchor,
          ...(version ? { walkId: id } : {}),
        },
        valid,
      );
      if (!r) return;
      for (const p of r.items) pool.set(p.id, p);
      $("#walk-nearby-state").textContent = "";
      paintCandidates();
      paintMap();
    } catch (e) {
      if (valid()) {
        $("#walk-nearby-state").innerHTML =
          '<button class="walk-create" id="nearby-retry">附近地点没加载出来 · 重试</button>';
        $("#nearby-retry").onclick = () => void loadNearby(anchor);
      }
    }
  }
  async function refreshRoute(before) {
    const own = ++revision;
    verified = null;
    notice = "";
    busy = selected.size >= 2;
    paint();
    if (!busy) return own;
    try {
      const r = await poll(
        "/api/citywalk/preview",
        {
          draftId: data.draftId,
          clusterIds: [group.id],
          stopIds: [...selected.keys()],
          startId,
          ...(version ? { walkId: id } : {}),
        },
        () => current() && stage === 2 && own === revision,
      );
      if (!r) return;
      if (r.route.blocked && before) {
        selected = before.selected;
        startId = before.startId;
        anchorId = before.anchorId;
        verified = before.verified;
        notice = "达到 15 公里，已取消新增地点";
        toast(notice);
      } else verified = r.route;
    } catch (e) {
      if (own === revision) {
        verified = { status: "preview" };
        notice = "仅预览 · 步行距离暂未核验";
        fail(e);
      }
    } finally {
      if (current() && stage === 2 && own === revision) {
        busy = false;
        paint();
      }
    }
    return own;
  }
  async function toggle(placeId) {
    if (!current() || stage !== 2 || saving) return;
    const p = pool.get(placeId);
    if (!p) return;
    const adding = !selected.has(placeId);
    if (adding && busy) return;
    if (adding && selected.size >= 100) {
      fail(Error("一条路线最多选择 100 个地点"));
      return;
    }
    const before = { selected: new Map(selected), startId, anchorId, verified };
    if (adding) {
      selected.set(placeId, p);
      anchorId = placeId;
    } else {
      selected.delete(placeId);
      if (anchorId === placeId) anchorId = selected.keys().next().value || "";
    }
    if (!selected.has(startId)) startId = selected.keys().next().value || "";
    const own = await refreshRoute(adding ? before : null);
    if (current() && stage === 2 && own === revision)
      void loadNearby(anchorId || group.anchor?.id);
  }
  async function save() {
    if (
      busy ||
      saving ||
      verified?.status !== "verified" ||
      verified.blocked ||
      selected.size < 2
    )
      return;
    if (!title.trim()) {
      fail(Error("请给路线起个名字"));
      return;
    }
    saving = true;
    paint();
    $("#walk-save").textContent = "正在保存…";
    try {
      await api(
        "/api/citywalks" + (version ? "/" + id : ""),
        {
          id,
          draftId: data.draftId,
          title: title.trim(),
          clusterIds: [group.id],
          stopIds: [...selected.keys()],
          startId,
          ...(version ? { version } : {}),
        },
        version ? "PUT" : "POST",
      );
      if (current()) {
        navigate("/home");
        toast("已收进我的 CityWalk");
      }
    } catch (e) {
      fail(e);
    } finally {
      saving = false;
      if (current() && stage === 2) {
        $("#walk-save").textContent = "保存路线 ✓";
        paint();
      }
    }
  }
  try {
    if (route.id && route.id !== "new") {
      content.innerHTML = '<p class="page-status">正在展开路线…</p>';
      previous = await api("/api/citywalks/" + encodeURIComponent(route.id));
      if (current()) {
        id = previous.id;
        version = previous.version;
        title = previous.title;
        selected = new Map(previous.stops.map((p) => [p.id, p]));
        startId = previous.stops[0].id;
        setTitle("编辑 CityWalk");
        await load(previous.city);
      }
    } else cityPage();
  } catch (e) {
    fail(e);
  }
  return cleanup;
}
