import {renderClassicWalk} from './classic-walk-view.js';
import { publishRoute } from "./discovery.js";
import { classicWalks, loadClassicWalks } from "./citywalk-classics.js";
import { boundarySvg, uniqueCities } from "./city-selection.js";
import { orderWalk, routeMetres, walkName } from "./citywalk-route.js";
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
const km = (distance) => (distance / 1000).toFixed(1);
const normalize = (name) => name.replace(/[\s·（）()]/g, "").replace(/市$/, "");
function walkArt(motif) {
  const landmark =
    motif === "gate"
      ? '<path d="M160 78h118v57H160z" fill="#ffb597"/><path d="m151 78 68-33 68 33z" fill="#e67f68"/><path d="M205 135v-27a14 14 0 0 1 28 0v27" fill="#fff8df"/><path d="m168 58 51-24 51 24" fill="none"/>'
      : motif === "lake"
        ? '<path d="m140 124 30-70 29 50 25-62 48 82" fill="#8acdac"/><path d="m228 89 29-16 29 16z" fill="#e99476"/><path d="M239 89v31m34-31v31"/><path d="M149 140q60-20 128 0" fill="none" stroke="#57bfb7"/>'
        : '<path d="M152 128V66h12v62m101 0V66h12v62" fill="#fff9e7"/><path d="M164 74q50 62 101 0M152 128h125M184 96v32m25-23v23m25-26v26" fill="none"/><path d="m168 137 92 0" stroke="#54b3b4"/>';
  return `<svg class="walk-art" viewBox="0 0 320 170" aria-hidden="true"><circle cx="274" cy="36" r="18" fill="#ffcf63"/><path d="M12 135Q60 91 83 121T155 149T298 145" fill="none" stroke="#fffdf2" stroke-width="15"/><path d="M12 135Q60 91 83 121T155 149T298 145" fill="none" stroke="#1c655e" stroke-width="2" stroke-dasharray="5 7"/><g stroke="#183c40" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${landmark}<path d="M64 115V87m-12 19q-22-30 0-37 26-9 25 25" fill="#65bd96"/><circle cx="83" cy="121" r="7" fill="#ffda73"/><circle cx="155" cy="149" r="7" fill="#fffdf2"/><path d="m22 42 5-9 5 9-5 9zM102 40h9m-4-4v8" fill="#fffdf2"/></g></svg>`;
}

export function createCityWalkHome({ api, navigate, toast }) {
  const rail = document.querySelector("#classic-walks"),
    dots = document.querySelector("#walk-dots");
  const list = document.querySelector("#my-walk-list"),
    more = document.querySelector("#more-walks"),
    auto = document.querySelector("#walk-auto");
  let active = false,
    index = 0,
    pauseUntil = 0,
    hovered = false,
    visible = true,
    request = 0,
    limit = 10;
  let paused = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function paintClassics(){
  rail.innerHTML = classicWalks
    .map(
      (w, i) =>
        `<article class="walk-slide ${w.theme}" aria-label="${i + 1} / ${classicWalks.length} · ${esc(w.city)}"><button data-classic="${w.id}" class="classic-open"><span class="walk-city">${esc(w.city)} <span aria-hidden="true">↗</span></span>${walkArt(w.motif)}<div class="walk-caption"><h3>${esc(w.title)}</h3><p>${w.stops.map(esc).join(" → ")}</p></div></button></article>`,
    )
    .join("");
  dots.innerHTML = classicWalks
    .map(
      (w, i) =>
        `<button data-walk-dot="${i}" aria-label="查看${esc(w.city)}路线" aria-current="${i === 0}"></button>`,
    )
    .join("");
  }
  void loadClassicWalks(api).then(paintClassics).catch(()=>{rail.textContent="经典路线暂未加载";});
  function syncAuto() {
    auto.textContent = paused ? "▶" : "Ⅱ";
    auto.setAttribute("aria-label", paused ? "开启自动轮播" : "暂停自动轮播");
  }
  function go(i, manual = false) {
    if(!classicWalks.length||!rail.children[i])return;
    index = i;
    rail.scrollTo({
      left: rail.children[i].offsetLeft - rail.firstElementChild.offsetLeft,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    if (manual) pauseUntil = Date.now() + 5000;
  }
  rail.addEventListener(
    "scroll",
    () => {
      const x = rail.getBoundingClientRect().left;
      index = [...rail.children].reduce(
        (best, el, i, all) =>
          Math.abs(el.getBoundingClientRect().left - x) <
          Math.abs(all[best].getBoundingClientRect().left - x)
            ? i
            : best,
        0,
      );
      [...dots.children].forEach((d, i) =>
        d.setAttribute("aria-current", i === index),
      );
    },
    { passive: true },
  );
  rail.addEventListener("pointerdown", () => {
    pauseUntil = Date.now() + 5000;
  });
  rail.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") hovered = true;
  });
  rail.addEventListener("pointerleave", () => {
    hovered = false;
  });
  rail.addEventListener(
    "wheel",
    () => {
      pauseUntil = Date.now() + 5000;
    },
    { passive: true },
  );
  rail.addEventListener("keydown", (e) => {
    if (classicWalks.length && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      go(
        (index + (e.key === "ArrowRight" ? 1 : -1) + classicWalks.length) %
          classicWalks.length,
        true,
      );
    }
  });
  rail.onclick = (e) => {
    const b = e.target.closest("[data-classic]");
    if (b) navigate("/citywalk/classic-" + b.dataset.classic);
  };
  dots.onclick = (e) => {
    const b = e.target.closest("[data-walk-dot]");
    if (b) go(Number(b.dataset.walkDot), true);
  };
  auto.onclick = () => {
    paused = !paused;
    syncAuto();
  };
  syncAuto();
  new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
  }).observe(rail);
  setInterval(() => {
    if (
      active &&
      visible &&
      !paused &&
      !hovered &&
      !document.hidden &&
      !rail.contains(document.activeElement) &&
      Date.now() >= pauseUntil &&
      !document.querySelector("#wizard").open
    )
      go((index + 1) % classicWalks.length);
  }, 1000);
  document.querySelector("#create-walk").onclick = () =>
    navigate("/citywalk/new");
  list.onclick = (e) => {
    const publish = e.target.closest("[data-publish-walk]");
    if (publish) {
      void publishRoute({ button: publish, kind: "citywalk", id: publish.dataset.publishWalk, api, navigate, toast });
      return;
    }
    const b = e.target.closest("[data-edit-walk]");
    if (b) navigate("/citywalk/" + b.dataset.editWalk);
  };
  async function refresh() {
    const revision = ++request;
    try {
      const walks = [];
      for (let offset = 0; offset < limit + 1; offset += 50) {
        const size = Math.min(50, limit + 1 - offset),
          page = await api(`/api/citywalks?limit=${size}&offset=${offset}`);
        walks.push(...page);
        if (page.length < size) break;
      }
      if (revision !== request) return;
      list.innerHTML =
        walks
          .slice(0, limit)
          .map(
            (w) =>
              `<div class="walk-card-wrap"><button class="my-walk-card" data-edit-walk="${esc(w.id)}"><span class="walk-pin" aria-hidden="true">↗</span><span><small>${esc(w.city.name)} · ${w.stops.length} 个地点</small><b>${esc(w.title)}</b><span class="walk-stop-names">${w.stops.map((p) => esc(p.name)).join(" → ")}</span></span></button><button type="button" class="route-share" data-publish-walk="${esc(w.id)}" aria-label="发布这条 CityWalk 到发现">分享 ↗</button></div>`,
          )
          .join("") ||
        '<div class="walk-empty"><span aria-hidden="true">〰</span><p>把想逛的地方，连成自己的路线。</p><button class="walk-create" data-empty-create>开始画路线 ↗</button></div>';
      list
        .querySelector("[data-empty-create]")
        ?.addEventListener("click", () => navigate("/citywalk/new"));
      more.hidden = walks.length <= limit;
    } catch (e) {
      if (revision === request) {
        list.innerHTML =
          '<p class="muted">路线暂时没加载出来。</p><button class="walk-create" data-walk-retry>重新加载 ↻</button>';
        list.querySelector("[data-walk-retry]").onclick = () => refresh();
      }
    }
  }
  more.onclick = async () => {
    more.disabled = true;
    limit += 5;
    try {
      await refresh();
    } catch (e) {
      toast(e.message);
    } finally {
      more.disabled = false;
    }
  };
  return {
    setActive(value) {
      active = value;
      if (value) void refresh();
    },
  };
}

export async function renderCityWalkEditor({
  route,
  content,
  setTitle,
  api,
  navigate,
  isCurrent,
  toast,
}) {
  if(route.id?.startsWith('classic-'))return renderClassicWalk({route,content,setTitle,api,isCurrent});
  let template = classicWalks.find((w) => "classic-" + w.id === route.id);
  const editing = route.id && route.id !== "new" && !template;
  const state = {
    id: crypto.randomUUID(),
    city: null,
    data: null,
    groups: new Set(),
    selected: new Map(),
    startId: "",
    title: "",
    phase: 0,
    filter: "",
    visible: 30,
    version: null,
    note: "",
  };
  let previous,
    citySequence = 0,
    searchTimer,
    mapRevision = 0,
    loadSequence = 0;
  let disposed = false;
  const current = () => !disposed && isCurrent();
  const $ = (q) => content.querySelector(q);
  function message(event) {
    const frame = $("#walk-map");
    if (
      current() &&
      frame &&
      event.source === frame.contentWindow &&
      event.origin === location.origin &&
      event.data?.type === "seatraces-map-ready"
    )
      paintMap();
  }
  window.addEventListener("message", message);
  const cleanup = () => {
    disposed = true;
    clearTimeout(searchTimer);
    window.removeEventListener("message", message);
  };
  setTitle(editing ? "编辑 CityWalk" : "画一条 CityWalk");
  function ordered() {
    return orderWalk([...state.selected.values()], state.startId).map((p) => ({
      ...p,
      name: walkName(p),
    }));
  }
  function paintMap() {
    const frame = $("#walk-map");
    if (!frame) return;
    const stops = ordered().map((p) => ({
      ...p,
      position: mainlandEligible(p)
        ? toGcj(p).split(",").map(Number)
        : [p.lng, p.lat],
    }));
    const focus = mainlandEligible(state.city)
      ? toGcj(state.city).split(",").map(Number)
      : [state.city.lng, state.city.lat];
    frame.contentWindow?.postMessage(
      {
        type: "seatraces-route",
        kind: "citywalk",
        lockView: true,
        view: "day",
        fitKey: "walk-" + mapRevision,
        viewPadding: [70, 85, 45, 85],
        focus,
        stops,
        connections: schematicConnections(stops),
        cities: [],
        cityConnections: [],
        segments: [],
      },
      location.origin,
    );
  }
  function header(step) {
    return `<div class="walk-steps" aria-label="编辑步骤">${["选城市", "选片区", "挑景点"].map((s, i) => `<span class="${step === i ? "active" : ""}">${i + 1} ${s}</span>`).join("")}</div>`;
  }
  function showError(e) {
    if (current()) {
      const target = $("#walk-error");
      if (target) target.textContent = e.message;
      else toast(e.message);
    }
  }
  function cityPage() {
    state.phase = 0;
    content.innerHTML = `<div class="walk-editor">${header(0)}<div class="walk-intro"><span class="eyebrow">YOUR CITY, YOUR WALK</span><h2>今天，逛哪座城？</h2></div><label for="walk-city-search" class="walk-label">目的地</label><input id="walk-city-search" type="search" placeholder="搜索城市，如上海" autocomplete="off"><div id="walk-city-results" class="choices"></div><p id="walk-error" class="error" role="alert"></p></div>`;
    $("#walk-city-search").oninput = (e) => {
      clearTimeout(searchTimer);
      const q = e.target.value,
        seq = ++citySequence;
      searchTimer = setTimeout(() => search(q, seq), 250);
    };
    async function search(q, seq) {
      try {
        const cities = uniqueCities(
          await api("/api/places?category=city&q=" + encodeURIComponent(q)),
          q ? 18 : 8,
        );
        if (!current() || state.phase !== 0 || seq !== citySequence) return;
        $("#walk-city-results").innerHTML =
          cities
            .map(
              (c, i) =>
                `<button class="choice" data-walk-city="${i}">${esc(c.name)}<small>${esc(c.province || c.country)}</small></button>`,
            )
            .join("") || '<p class="muted">换个城市名称试试。</p>';
        $("#walk-city-results").onclick = (e) => {
          const b = e.target.closest("[data-walk-city]");
          if (b) {
            state.selected.clear();
            state.groups.clear();
            state.startId = "";
            state.title = "";
            void load(cities[Number(b.dataset.walkCity)]);
          }
        };
      } catch (e) {
        showError(e);
      }
    }
    void search("", ++citySequence);
  }
  async function load(city) {
    const sequence = ++loadSequence;
    if (template && normalize(city.name) !== template.city) {
      template = null;
      state.note = "";
    }
    state.city = city;
    state.phase = 1;
    content.innerHTML = `<div class="walk-editor">${header(1)}<div class="walk-loading"><span aria-hidden="true">〰</span><h2>正在铺开${esc(city.name)}…</h2><p>找一片喜欢的街区。</p></div><p id="walk-error" class="error" role="alert"></p><button class="walk-create" id="walk-load-back">重新选择城市</button></div>`;
    $("#walk-load-back").onclick = () => {
      loadSequence++;
      cityPage();
    };
    try {
      let data;
      for (let attempts = 0; attempts < 120; attempts++) {
        data = await api(
          "/api/citywalk/catalog/" + encodeURIComponent(city.id),
        );
        if (!current() || sequence !== loadSequence) return;
        if (data.status !== "loading") break;
        await new Promise((r) => setTimeout(r, data.retryAfterMs || 1500));
        if (!current() || sequence !== loadSequence) return;
      }
      if (!data?.clusters) throw Error("城市仍在准备，请稍后再试");
      state.data = data;
      if (previous && previous.city.id === city.id) {
        state.groups = new Set(
          previous.cluster_ids.filter((id) =>
            data.clusters.some((g) => g.id === id),
          ),
        );
        for (const g of data.clusters)
          if (g.members.some((p) => state.selected.has(p.id)))
            state.groups.add(g.id);
        if (!state.groups.size && data.clusters[0])
          state.groups.add(data.clusters[0].id);
        if (state.selected.size) {
          state.phase = 2;
          sightsPage();
          return;
        }
      }
      if (template && !state.selected.size) {
        const missing = [];
        for (const name of template.stops) {
          const matches = data.clusters.flatMap((g) =>
            g.members
              .filter((p) =>
                [p.name, ...(p.aliases || [])].some(
                  (n) => normalize(n) === normalize(name),
                ),
              )
              .map((p) => ({ g, p })),
          );
          if (matches.length === 1) {
            state.selected.set(matches[0].p.id, matches[0].p);
            state.groups.add(matches[0].g.id);
          } else missing.push(name);
        }
        state.title = template.title;
        state.startId = state.selected.keys().next().value || "";
        if (missing.length)
          state.note =
            "请从片区里补选：" + missing.join("、") + "（尚未找到唯一匹配）";
      }
      clustersPage();
    } catch (e) {
      if (!current() || sequence !== loadSequence) return;
      showError(e);
      const retry = document.createElement("button");
      retry.className = "primary";
      retry.textContent = "再试一次 ↻";
      retry.onclick = () => load(city);
      content.append(retry);
    }
  }
  function clustersPage() {
    state.phase = 1;
    const d = state.data;
    content.innerHTML = `<div class="walk-editor">${header(1)}<div class="walk-intro"><span class="eyebrow">${esc(state.city.name)} · CITYWALK</span><h2>选一片，或多逛几片</h2></div><div id="walk-boundary" class="walk-boundary">${boundarySvg(d, d.clusters, [...state.groups])}</div><div class="walk-cluster-list">${d.clusters.map((g) => `<button class="walk-cluster" data-walk-cluster="${esc(g.id)}" aria-pressed="${state.groups.has(g.id)}"><span>${g.number}</span><b>${esc(g.name)}</b><small>${g.memberCount} 处</small></button>`).join("")}</div>${!d.clusters.length ? '<p class="muted">这里暂时没有可选景点，换座城市试试。</p>' : ""}<p id="walk-error" class="error" role="alert"></p><div class="walk-actions"><button id="walk-change-city" class="walk-create">换座城市</button><button id="walk-pick-sights" class="primary" ${!state.groups.size ? "disabled" : ""}>挑景点 →</button></div></div>`;
    function toggle(id) {
      state.groups.has(id) ? state.groups.delete(id) : state.groups.add(id);
      content
        .querySelectorAll("[data-walk-cluster]")
        .forEach((b) =>
          b.setAttribute(
            "aria-pressed",
            state.groups.has(b.dataset.walkCluster),
          ),
        );
      $("#walk-boundary").innerHTML = boundarySvg(d, d.clusters, [
        ...state.groups,
      ]);
      $("#walk-pick-sights").disabled = !state.groups.size;
    }
    $(".walk-cluster-list").onclick = (e) => {
      const b = e.target.closest("[data-walk-cluster]");
      if (b) toggle(b.dataset.walkCluster);
    };
    $("#walk-boundary").onclick = (e) => {
      const b = e.target.closest("[data-cluster]");
      if (b) toggle(b.dataset.cluster);
    };
    $("#walk-boundary").onkeydown = (e) => {
      if (
        ["Enter", " "].includes(e.key) &&
        e.target.matches("[data-cluster]")
      ) {
        e.preventDefault();
        toggle(e.target.dataset.cluster);
      }
    };
    $("#walk-change-city").onclick = () => {
      state.selected.clear();
      state.groups.clear();
      previous = null;
      cityPage();
    };
    $("#walk-pick-sights").onclick = () => {
      const ids = new Set(
        d.clusters
          .filter((g) => state.groups.has(g.id))
          .flatMap((g) => g.members.map((p) => p.id)),
      );
      // Changing scope deliberately removes newly selected stops outside that scope.
      for (const id of state.selected.keys())
        if (!ids.has(id) && !previous?.stops.some((p) => p.id === id))
          state.selected.delete(id);
      if (!state.selected.has(state.startId))
        state.startId = state.selected.keys().next().value || "";
      state.filter = "";
      state.visible = 30;
      sightsPage();
      document.querySelector("#detail-page").scrollTop = 0;
    };
  }
  function candidates() {
    return [
      ...new Map(
        state.data.clusters
          .filter((g) => state.groups.has(g.id))
          .flatMap((g) => g.members)
          .map((p) => [p.id, p]),
      ).values(),
    ]
      .map((p) => ({
        ...p,
        name: walkName(p),
        aliases: [...(p.aliases || []), p.name],
      }))
      .sort(
        (a, b) =>
          (Number(b.score?.total ?? b.score ?? 0) || 0) -
          (Number(a.score?.total ?? a.score ?? 0) || 0),
      );
  }
  function sightsPage() {
    state.phase = 2;
    mapRevision++;
    content.innerHTML = `<div class="walk-editor">${header(2)}<div class="walk-intro"><span class="eyebrow">${esc(state.city.name)} · YOUR WALK</span><h2>把想逛的地方连起来</h2><button id="walk-change-groups" class="walk-create">重选片区 ↶</button></div>${state.note ? `<p class="walk-notice">${esc(state.note)}</p>` : ""}${template ? `<p class="walk-source">路线灵感：<a href="${esc(template.source)}" target="_blank" rel="noopener">${esc(template.sourceName)} ↗</a> · 可自由修改</p>` : ""}<label class="walk-label" for="walk-title">路线名称</label><input id="walk-title" maxlength="80" value="${esc(state.title || state.city.name + " · 我的 CityWalk")}"><div class="walk-preview"><iframe id="walk-map" src="/amap-view.html?mode=home" title="CityWalk 路线预览"></iframe></div><div id="walk-selection"></div><label class="walk-label" for="walk-sight-search">挑选景点</label><input id="walk-sight-search" type="search" placeholder="在所选片区内搜索" value="${esc(state.filter)}"><div id="walk-sights" class="walk-sights"></div><button id="walk-more-sights" class="loadmore">再看一些 ↓</button><p id="walk-error" class="error" role="alert"></p><div class="walk-save-bar"><span id="walk-count"></span><button id="walk-save" class="primary">保存路线 ✓</button></div></div>`;
    state.title = $("#walk-title").value;
    $("#walk-title").oninput = (e) => {
      state.title = e.target.value;
    };
    $("#walk-change-groups").onclick = clustersPage;
    $("#walk-sight-search").oninput = (e) => {
      state.filter = e.target.value;
      state.visible = 30;
      paintSights();
    };
    $("#walk-more-sights").onclick = () => {
      state.visible += 30;
      paintSights();
    };
    $("#walk-sights").onclick = (e) => {
      const b = e.target.closest("[data-walk-place]");
      if (!b) return;
      const p = candidates().find((p) => p.id === b.dataset.walkPlace);
      if (!p) return;
      if (state.selected.has(p.id)) state.selected.delete(p.id);
      else {
        if (state.selected.size >= 100) {
          showError(Error("一条路线最多选择 100 个地点"));
          return;
        }
        state.selected.set(p.id, p);
      }
      if (!state.selected.has(state.startId))
        state.startId = state.selected.keys().next().value || "";
      updateSelection();
      paintSights();
    };
    $("#walk-save").onclick = save;
    paintSights();
    updateSelection();
  }
  function paintSights() {
    const all = candidates().filter((p) =>
      [p.name, ...(p.aliases || [])].some((n) =>
        n.includes(state.filter.trim()),
      ),
    );
    $("#walk-sights").innerHTML =
      all
        .slice(0, state.visible)
        .map(
          (p) =>
            `<button class="walk-sight" data-walk-place="${esc(p.id)}" aria-pressed="${state.selected.has(p.id)}"><span class="walk-check" aria-hidden="true">${state.selected.has(p.id) ? "✓" : "+"}</span><span><b>${esc(p.name)}</b>${p.district ? `<small>${esc(p.district)}</small>` : ""}</span></button>`,
        )
        .join("") || '<p class="muted">这个片区里没有匹配项。</p>';
    $("#walk-more-sights").hidden = state.visible >= all.length;
  }
  function updateSelection() {
    const stops = ordered(),
      length = routeMetres(stops);
    mapRevision++;
    $("#walk-selection").innerHTML = stops.length
      ? `<div class="walk-order"><label for="walk-start">从这里出发 <select id="walk-start">${stops.map((p) => `<option value="${esc(p.id)}" ${p.id === state.startId ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label><ol>${stops.map((p) => `<li><span>${esc(p.name)}</span><button data-remove-stop="${esc(p.id)}" aria-label="移除${esc(p.name)}">×</button></li>`).join("")}</ol><p>景点连线约 ${km(length)} 公里${length > 15000 ? " · 距离较长，可以拆成几条路线" : ""}</p></div>`
      : '<p class="walk-prompt">点选下方景点，路线会在这里展开。</p>';
    $("#walk-start")?.addEventListener("change", (e) => {
      state.startId = e.target.value;
      updateSelection();
    });
    $("#walk-selection").onclick = (e) => {
      const b = e.target.closest("[data-remove-stop]");
      if (b) {
        state.selected.delete(b.dataset.removeStop);
        if (!state.selected.has(state.startId))
          state.startId = state.selected.keys().next().value || "";
        updateSelection();
        paintSights();
      }
    };
    $("#walk-count").textContent = stops.length + " 个地点";
    $("#walk-save").disabled = stops.length < 2;
    paintMap();
  }
  async function save() {
    if (!state.title.trim()) {
      showError(Error("给路线起个名字吧"));
      return;
    }
    const button = $("#walk-save");
    button.disabled = true;
    button.textContent = "正在收好…";
    $("#walk-error").textContent = "";
    try {
      const result = await api(
        "/api/citywalks" + (state.version ? "/" + state.id : ""),
        {
          id: state.id,
          draftId: state.data.draftId,
          title: state.title.trim(),
          clusterIds: [...state.groups],
          stopIds: [...state.selected.keys()],
          startId: state.startId,
          ...(state.version ? { version: state.version } : {}),
        },
        state.version ? "PUT" : "POST",
      );
      state.id = result.id;
      state.version = result.version;
      if (!current()) return;
      navigate("/home");
      toast("已收进我的 CityWalk");
      requestAnimationFrame(() =>
        document
          .querySelector("#my-citywalks")
          .scrollIntoView({ block: "start", behavior: "smooth" }),
      );
    } catch (e) {
      showError(e);
    } finally {
      button.disabled = false;
      button.textContent = "保存路线 ✓";
    }
  }
  content.innerHTML = '<p class="page-status">正在展开路线…</p>';
  try {
    if (editing) {
      previous = await api("/api/citywalks/" + encodeURIComponent(route.id));
      if (current()) {
        state.id = previous.id;
        state.version = previous.version;
        state.title = previous.title;
        state.selected = new Map(previous.stops.map((p) => [p.id, p]));
        state.startId = previous.stops[0].id;
        await load(previous.city);
      }
    } else if (template) {
      const cities = uniqueCities(
        await api(
          "/api/places?category=city&q=" + encodeURIComponent(template.city),
        ),
      );
      const city = cities.find(
        (c) => c.country === "CN" && normalize(c.name) === template.city,
      );
      if (current()) {
        if (city) await load(city);
        else cityPage();
      }
    } else cityPage();
  } catch (e) {
    if (current()) {
      content.innerHTML = `<p class="page-status" role="alert">${esc(e.message)}</p><button id="walk-new" class="primary">新画一条 ↗</button>`;
      $("#walk-new").onclick = () => navigate("/citywalk/new");
    }
  }
  return cleanup;
}
