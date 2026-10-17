import { mountDiscovery, mountPersonalPosts, publishRoute } from "./discovery.js";
import {mountComposer} from './social-composer.js';
import {mountSocialPost} from './social-post.js';
import {guestPage} from './guest-policy.js';
import { uniqueCities } from "./city-selection.js";
import { createCityWalkHome, renderCityWalkEditor } from "./citywalk.js";
import { createTabMotion } from "./tab-motion.js";
import { createPageNavigation } from "./page-navigation.js";
import { createPageMotion } from "./page-motion.js";
import { renderProfilePage } from "./profile-pages.js";
import {refreshPersonalOverview} from './personal-center.js';
import { mountAgent } from "./agent-page.js";
import { mountAgentLauncher } from './agent-launcher.js';
import { renderInbox } from './inbox.js';
import { mountTripServices } from "./trip-services.js";
import { mountServiceMapDock } from "./service-map-dock.js";
import { plannerScene, serviceScene, savedServicePoints } from "./map-scene.js";
import { toGcj, mainlandEligible } from "./coordinates.js";
import { currentPosition } from "./geolocation.js";
import { createPresenceRecorder } from "./presence.js";
import { schematicConnections } from "./route-curves.js";
import {
  overviewPoints,
  mapPoint,
  hasPosition,
  amapLegUrl,
} from "./trip-view.js";
import { scenicMemberMarkup, byScore } from "./scenic-view.js";
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
async function api(path, body, method) {
  let r;
  try {
    r = await fetch(path, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", "X-Seatraces": "1" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    $("#connection-status").hidden = false;
    throw Object.assign(Error("暂时连不上服务，请点重连后再试"), {
      status: 503,
    });
  }
  const data = await r.json();
  if (r.status === 401) location.replace("/login.html");
  if (data.code === "backend_unavailable")
    $("#connection-status").hidden = false;
  if (!r.ok)
    throw Object.assign(Error(data.error || "暂时没有连上，再试一次吧"), {
      status: r.status,
      code: data.code,
    });
  return data;
}
async function checkConnection(retry = false) {
  const button = $("#reconnect");
  if (button.disabled) return;
  button.disabled = true;
  try {
    const response = await fetch("/api/health", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !(await response.json()).ok) throw Error("offline");
    $("#connection-status").hidden = true;
    if (retry) {
      $("#travel-map").contentWindow.location.reload();
      me = await api("/api/me");
      syncProfile();
      toast("已重新连上");
    }
  } catch {
    $("#connection-status").hidden = false;
  } finally {
    button.disabled = false;
  }
}
$("#reconnect").onclick = () => checkConnection(true);
window.addEventListener("online", () => checkConnection());
const state = {
  step: 0,
  origin: { label: "" },
  cities: [],
  start: "",
  end: "",
  session: null,
  catalog: {},
  selections: {},
  questions: [],
  answers: {
    interests: [],
    pace: "balanced",
    transport: "balanced",
    crowd: "balanced",
    revisit: "new",
  },
  busy: false,
  trip: null,
  day: 0,
  mapView: "overview",
  fitRevision: 0,
  routes: {},
  limit: 24,
  district: "",
  inspiration: null,
};
let me,
  cityResults = [],
  searchTimer,
  searchSeq = 0,
  toastTimer;
function toast(s) {
  $("#toast").textContent = s;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4500);
}
function syncProfile() {
  $('#admin-entry').hidden=me?.user?.role!=='admin';
  $("#profile-name").textContent = me?.user?.nickname || "旅行者";
  const avatar = $("#profile-avatar");
  avatar.replaceChildren();
  if (me?.user?.avatarUrl) {
    const image = document.createElement("img");
    image.src = me.user.avatarUrl;
    image.alt = "";
    avatar.append(image);
  } else avatar.textContent = me?.user?.avatar || "☺";
  $("#profile-account-label").textContent = me?.user
    ? "管理我的账号 ↗"
    : "登录，收好你的旅行";
}
const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;
const tabMotion = createTabMotion({
  buttons: document.querySelectorAll("[data-page]"),
  lottie: window.lottie,
  reducedMotion,
});
const panels = {
  home: "#home",
  discover: "#discover-page",
  profile: "#profile-page",
};
const pageNames = { home: "旅行", discover: "发现", profile: "我的" };
let agentContext = {page:'home'};
let pageRevision = 0,
  pageCleanup,
  serviceDock,
  serviceMap,
  plannerMap,
  originCity;
const boundaryCache = new Map();
let plannerCity,
  boundaryRequest = 0;
function workspace(mode) {
  $("#home").classList.toggle("map-workspace", Boolean(mode));
  $("#home").dataset.workspace = mode || "";
  $("#services-panel").hidden = mode !== "services";
  if (mode) $("#home").scrollTop = 0;
}
function closeWizard() {
  $("#wizard").close();
  ++boundaryRequest;
  clearTimeout(districtRefresh);
  workspace(null);
  paintMap();
}
function publishPlanner() {
  if (!$("#wizard").open || !plannerCity) return;
  const city = plannerCity,
    clusterStep = state.step >= 3 && state.step < 3 + state.cities.length;
  const catalog = clusterStep ? state.catalog[city.id] : null;
  plannerMap = plannerScene({
    city,
    boundary: catalog?.boundary || boundaryCache.get(city.id),
    clusters: catalog?.clusters || [],
    selected: state.selections[city.id] || [],
    district: clusterStep ? state.district : "",
    contextKey: `planner:${city.id || city.name}`,
    fitKey: `planner:${city.id || city.name}:${clusterStep ? state.district : "city"}`,
  });
  paintMap();
}
async function focusPlannerCity(city, withBoundary = true) {
  if (!city || !$("#wizard").open) return;
  plannerCity = city;
  const revision = ++boundaryRequest;
  publishPlanner();
  if (!withBoundary || !city.id || boundaryCache.has(city.id)) return;
  try {
    const r = await api(
      `/api/journey/cities/${encodeURIComponent(city.id)}/boundary`,
    );
    boundaryCache.set(city.id, r.boundary);
    if (
      revision !== boundaryRequest ||
      !$("#wizard").open ||
      plannerCity?.id !== city.id
    )
      return;
    publishPlanner(); // Geometry may arrive later; preserve a manually moved camera.
  } catch {
    /* Boundary failure must not block answering the questionnaire. */
  }
}
function syncPlannerStep() {
  if (!$("#wizard").open) return;
  if (state.step === 0 && hasPosition(state.origin))
    void focusPlannerCity(
      originCity || { ...state.origin, name: state.origin.label },
      false,
    );
  else if (state.step === 1 && state.cities.length)
    void focusPlannerCity(state.cities.at(-1));
  else if (state.step >= 3 && state.step < 3 + state.cities.length)
    void focusPlannerCity(state.cities[state.step - 3]);
  // Dates and preferences keep the existing city and camera stable.
}
function keepTrip(trip) {
  state.trip = trip;
  localStorage.setItem("seatraces-last-trip", trip.id);
}
const cityWalkHome = createCityWalkHome({
  api,
  authenticated:()=>Boolean(me?.user),
  navigate: (path) => navigation.go(path),
  toast,
});
const pageMotion = createPageMotion();
const navigation = createPageNavigation({
  onRepeat: (route) =>
    $(panels[route.page] || "#detail-page").scrollTo({
      top: 0,
      behavior: reducedMotion() ? "auto" : "smooth",
    }),
  onChange: (route, { animate, direction }) => {
    if(me?.user) void fetch('/api/activity',{method:'POST',headers:{'Content-Type':'application/json','X-Seatraces':'1'},body:JSON.stringify({page:route.page,action:'open'})}).catch(()=>{});
    if(route.page!=='agent')agentContext={page:route.page,...(['history','services'].includes(route.page)&&route.id?{tripId:route.id,...(route.params?.day?{day:Number(route.params.day)}:{})}:state.trip?{tripId:state.trip.id,day:state.day}:{})};
    document.body.classList.toggle('agent-open',route.page==='agent');
    if (!me?.user && !guestPage(route)) {
      location.replace("/login.html");
      return;
    }
    const revision = ++pageRevision,
      serviceView = route.page === "services",
      detail = !panels[route.page] && !serviceView;
    setBusy(false);
    if ($("#wizard").open) closeWizard();
    serviceMap = null;
    workspace(serviceView ? "services" : null);
    pageCleanup?.();
    pageCleanup = null;
    serviceDock = null;
    cityWalkHome.setActive(route.page === "home");
    for (const [name, selector] of Object.entries(panels))
      $(selector).hidden = name !== (serviceView ? "home" : route.page);
    $("#detail-page").hidden = !detail;
    $(".bottom-nav").hidden = detail;
    document.body.classList.toggle("detail-open", detail);
    pageMotion($(detail ? '#page-content' : panels[serviceView ? 'home' : route.page]), {animate,direction});
    tabMotion.select(detail ? "profile" : serviceView ? "home" : route.page, {
      animate: animate && !detail,
    });
    document.querySelectorAll("[data-page]").forEach((button) => {
      if (
        button.dataset.page ===
        (detail ? "profile" : serviceView ? "home" : route.page)
      )
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    const setTitle = (title) => {
      $("#detail-title").textContent = title;
      document.title = title + " · SeaTraces";
    };
    if (serviceView) {
      document.title = "沿途吃住 · SeaTraces";
      $("#services-back").onclick = () => {
        navigation.go("/home");
        if (state.trip) paintTrip();
      };
      const content = document.createElement("div");
      $("#services-content").replaceChildren(content);
      content.innerHTML =
        '<p class="page-status" role="status">正在打开这一天…</p>';
      const current = () => revision === pageRevision;
      const ready = async () => {
        try {
          if (state.trip?.id !== route.id) {
            const trip = await api(
              "/api/trips/" + encodeURIComponent(route.id),
            );
            if (!current()) return;
            keepTrip(trip);
          }
          const day = Number(route.params?.day || 0);
          if (!Number.isInteger(day) || !state.trip.plan.days[day])
            throw Error("这一天不存在");
          state.day = day;
          state.mapView = "day";
          paintMap();
          serviceDock = mountServiceMapDock({
            route,
            content,
            api,
            isCurrent: current,
            navigate: (path) => navigation.go(path),
            onScene: (slot, id, focusRevision) => {
              serviceMap = { slot, id, focusRevision };
              paintMap();
            },
            onTrip: (trip) => {
              keepTrip(trip);
              paintTrip(false);
            },
          });
          const dock = serviceDock;
          pageCleanup = () => dock.dispose();
        } catch (e) {
          if (current()) content.textContent = e.message;
        }
      };
      void ready();
    } else if (detail) {
      // A render owns its container so a delayed response cannot overwrite a later page.
      const content = document.createElement("div");
      $("#page-content").replaceChildren(content);
      $("#detail-page").scrollTop = 0;
      if (['post','compose'].includes(route.page)) {
        const mount=route.page==='post'?mountSocialPost:mountComposer;
        void mount({route,content,setTitle,api,navigate:path=>navigation.go(path),toast,isCurrent:()=>revision===pageRevision,onAdopt:adoptSocialRoute}).then(cleanup=>{if(revision===pageRevision)pageCleanup=cleanup;else cleanup?.();});
      } else if (['settings','messages','social-messages'].includes(route.page)) {
        void renderInbox({route,content,setTitle,api,navigate:path=>navigation.go(path),isCurrent:()=>revision===pageRevision});
      } else if (route.page === 'agent') {
        pageCleanup = mountAgent({content,setTitle,api,userId:me.user.id,context:agentContext,isCurrent:()=>revision===pageRevision,navigate:path=>navigation.go(path)});
      } else if (route.page === "citywalk") {
        void renderCityWalkEditor({
          route,
          content,
          setTitle,
          api,
          toast,
          navigate: (path) => navigation.go(path),
          isCurrent: () => revision === pageRevision,
        }).then((cleanup) => {
          if (revision === pageRevision) pageCleanup = cleanup;
          else cleanup?.();
        });
      } else
        void renderProfilePage({
          route,
          content,
          setTitle,
          api,
          esc,
          isCurrent: () => revision === pageRevision,
          navigate: (path) => navigation.go(path),
          onTrip: (trip) => {
            selectPage("home");
            showTrip(trip).catch((e) => toast(e.message));
          },
          onUser: (user) => {
            me = { user };
            syncProfile();
          },
          onLogout: () => {
            if (presence.isEnabled()) presence.toggle();
            localStorage.removeItem("seatraces-last-trip");
            location.replace("/login.html");
          },
        });
      $("#detail-title").focus({ preventScroll: true });
    } else {
      $("#page-content").replaceChildren();
      document.title = pageNames[route.page] + " · SeaTraces";
      if (route.page === "discover") pageCleanup = mountDiscovery({ content: $("#discovery-content"), api, navigate:path=>navigation.go(path),toast });
      if (route.page === "profile") {
        syncProfile();
        void refreshPersonalOverview({element:$('#personal-overview'),api,isCurrent:()=>revision===pageRevision});
        pageCleanup=mountPersonalPosts({content:$('#personal-posts'),api,navigate:path=>navigation.go(path),toast});
      }
      if (route.page === "home") {
        if (state.trip) paintTrip();
        else paintMap();
      }
    }
  },
});
function selectPage(page) {
  navigation.go("/" + page);
}
$("#page-back").onclick = () => navigation.back();
mountAgentLauncher($('#ask-ai'));
$("#ask-ai").onclick = () => {
  if(agentContext.page==='home'&&state.trip)agentContext={page:'home',tripId:state.trip.id,day:state.day};
  navigation.go('/agent');
};
document.querySelectorAll("[data-page]").forEach((button) => {
  button.onclick = () => selectPage(button.dataset.page);
});
document.querySelectorAll("[data-open-travel]").forEach((button) => {
  button.onclick = () => selectPage("home");
});
document.querySelectorAll("[data-profile-page]").forEach((button) => {
  button.onclick = () => selectPage(button.dataset.profilePage);
});
const presence = createPresenceRecorder({
  getTrip: () => state.trip,
  api,
  onState: (enabled, message) => {
    const b = $("#record-presence");
    if (b) {
      b.setAttribute("aria-pressed", enabled);
      b.textContent = enabled ? "到访记录中 ◎" : "记录到访 ◎";
    }
    if (message) toast(message);
  },
});
async function ensureUser() {
  me = await api("/api/me");
  syncProfile();
  if (me.user) return;
  location.replace("/login.html");
  throw Error("请先登录");
}
function heading(label, title, stamp = "") {
  return `<div class="eyebrow">${esc(label)}</div>${stamp ? `<div class="stamp" aria-hidden="true">${stamp}</div>` : ""}<h1 id="question-title" tabindex="-1">${esc(title)}</h1>`;
}
function setBusy(value, title) {
  state.busy = value;
  if (value) $("#form-error").textContent = "";
  $("#next").disabled = value;
  $("#back").disabled = value;
  if (value && title)
    $("#question").innerHTML =
      `<div class="loading"><div class="spinner" aria-hidden="true"></div><h1 id="question-title">${esc(title)}</h1></div>`;
}
function invalidateSession() {
  state.session = null;
  state.catalog = {};
  state.selections = {};
  state.questions = [];
}
async function turn(step) {
  if (state.busy) return;
  setBusy(true);
  const paper = $(".paper");
  paper.classList.remove("arrive");
  paper.classList.add("tear");
  await new Promise((r) =>
    setTimeout(
      r,
      matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300,
    ),
  );
  if (!$("#wizard").open) {
    paper.classList.remove("tear");
    setBusy(false);
    return;
  }
  state.step = step;
  state.limit = 24;
  state.district = "";
  paper.classList.remove("tear");
  paper.classList.add("arrive");
  setBusy(false);
  await render();
}
async function render() {
  if (!$("#wizard").open) return;
  syncPlannerStep();
  const s = state.step;
  $("#question").onclick = null;
  $("#question").onkeydown = null;
  $("#form-error").textContent = "";
  $("#back").hidden = s === 0;
  $("#next").textContent =
    s === 3 + state.cities.length + state.questions.length - 1 &&
    state.questions.length
      ? "排好行程 ↗"
      : "下一页 →";
  $("#progress").textContent =
    String(s + 1).padStart(2, "0") +
    " / " +
    (3 + state.cities.length + (state.questions.length || 5));
  $("#question").scrollTop = 0;
  if (s === 0) {
    $("#question").innerHTML =
      heading("START HERE", "您从哪里出发？", "↗") +
      `<label class="field"><span>出发地</span><input id="origin" placeholder="输入出发城市或地点" autocomplete="off" value="${esc(state.origin.label)}"></label><button id="locate" class="inline-action">◎ 用当前位置</button><div id="city-results" class="choices"></div>`;
    $("#origin").oninput = (e) => {
      state.origin = { label: e.target.value };
      originCity = null;
      invalidateSession();
      searchCities(e.target.value, true);
    };
    $("#locate").onclick = () => locate(false);
    void searchCities("", true, true);
    if (!state.origin.label)
      navigator.permissions
        ?.query({ name: "geolocation" })
        .then((p) => {
          if (p.state === "granted" && state.step === 0) locate(true);
        })
        .catch(() => {});
  } else if (s === 1) {
    $("#question").innerHTML =
      heading("WHERE TO", "您要到哪儿去？") +
      `<div id="selected-cities" class="chip-row"></div><input id="city-search" class="search" aria-label="搜索目的城市" placeholder="搜索城市，最多选 5 座" autocomplete="off"><div id="city-results" class="choices"></div>`;
    paintCities();
    $("#city-search").oninput = (e) => searchCities(e.target.value, false);
    await searchCities("", false, true);
  } else if (s === 2) {
    $("#question").innerHTML =
      heading("SAVE THE DATE", "什么时候出发，什么时候回来？", "◷") +
      `<div class="date-row"><label class="field"><span>出发</span><input id="start" type="date" value="${esc(state.start)}" aria-label="出发日期"></label><label class="field"><span>回来</span><input id="end" type="date" min="${esc(state.start)}" value="${esc(state.end)}" aria-label="返回日期"></label></div>`;
    $("#start").onchange = (e) => {
      state.start = e.target.value;
      $("#end").min = state.start;
      if (state.end < state.start) {
        state.end = state.start;
        $("#end").value = state.end;
      }
      invalidateSession();
    };
    $("#end").onchange = (e) => {
      state.end = e.target.value;
      invalidateSession();
    };
  } else if (s < 3 + state.cities.length) {
    const city = state.cities[s - 3];
    try {
      if (!state.catalog[city.id]) {
        setBusy(true, "正在铺开" + city.name + "…");
        const sessionId = state.session.id;
        let data;
        let reconnects = 0;
        do {
          try {
            data = await api(
              `/api/journey/sessions/${sessionId}/cities/${encodeURIComponent(city.id)}?async=1`,
              {},
            );
            reconnects = 0;
          } catch (error) {
            if (error.status !== 503 || reconnects++ >= 2) throw error;
            // This is an idempotent read-job poll, safe to resume after a brief
            // proxy/tunnel disconnect without starting another city computation.
            data = { status: "loading", retryAfterMs: 1500 };
          }
          if (
            state.session?.id !== sessionId ||
            !$("#wizard").open ||
            state.step !== s
          ) {
            setBusy(false);
            return;
          }
          if (data.status === "loading")
            await new Promise((resolve) =>
              setTimeout(resolve, data.retryAfterMs || 1500),
            );
        } while (data.status === "loading");
        state.catalog[city.id] = data;
        if(state.inspiration){
          const ids=new Set(state.inspiration.placeIds),matches=data.clusters.flatMap(g=>g.members).filter(p=>ids.has(p.id));
          // Reuse the same validated wish endpoint used by the ordinary questionnaire.
          for(const p of matches.slice(0,60)){if(state.session?.id!==sessionId||state.step!==s||!$('#wizard').open)return;await api(`/api/journey/sessions/${sessionId}/wishes`,{placeId:p.id,wanted:true});p.wanted=true;}
          if(matches.length)toast(`已带入 ${matches.length} 个当前可选地点`);
        }
      }
      setBusy(false);
      renderClusters(city);
      refreshDistricts(city);
    } catch (e) {
      setBusy(false);
      $("#question").innerHTML =
        heading("TRY AGAIN", city.name + "还没准备好") +
        `<p class="muted">${esc(e.message)}</p><button id="retry-city" class="primary">再试一次</button>`;
      $("#retry-city").onclick = () => render();
      $("#next").disabled = true;
    }
  } else {
    const q = state.questions[s - 3 - state.cities.length];
    if (!q) return;
    const selected = state.answers[q.id];
    $("#question").innerHTML =
      heading("MAKE IT YOURS", q.title) +
      `<div class="choices">${q.options
        .map((o) => {
          const value = typeof o === "string" ? o : o.value,
            label = typeof o === "string" ? o : o.label;
          return `<button class="choice" data-answer="${esc(value)}" aria-pressed="${Array.isArray(selected) ? selected.includes(value) : selected === value}">${esc(label)}</button>`;
        })
        .join("")}</div>`;
    $("#question").onclick = (e) => {
      const el = e.target.closest("[data-answer]");
      if (!el) return;
      const value = el.dataset.answer;
      if (q.type === "multi") {
        const a = state.answers[q.id] || [];
        state.answers[q.id] = a.includes(value)
          ? a.filter((v) => v !== value)
          : [...a, value];
      } else state.answers[q.id] = value;
      render();
    };
  }
  $("#question-title")?.focus({ preventScroll: true });
}
function searchCities(q, origin, immediate = false) {
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  const work = async () => {
    try {
      const result = await api(
        "/api/places?category=city&q=" + encodeURIComponent(q),
      );
      if (seq !== searchSeq || state.step !== (origin ? 0 : 1)) return;
      cityResults = uniqueCities(result, q ? 18 : 8);
      $("#city-results").innerHTML =
        cityResults
          .map(
            (c, i) =>
              `<button class="choice" data-city="${i}" aria-pressed="${state.cities.some((x) => x.id === c.id)}">${esc(c.name)}<small>${esc(c.province || c.country)}</small></button>`,
          )
          .join("") || '<p class="muted">换个城市名称试试</p>';
      $("#city-results").onclick = (e) => {
        const el = e.target.closest("[data-city]");
        if (!el) return;
        const c = cityResults[Number(el.dataset.city)];
        if (origin) {
          state.origin = { label: c.name, lat: c.lat, lng: c.lng };
          originCity = c;
          void focusPlannerCity(c, false);
          $("#origin").value = c.name;
          $("#city-results").innerHTML = "";
          invalidateSession();
        } else {
          if (state.cities.some((x) => x.id === c.id))
            state.cities = state.cities.filter((x) => x.id !== c.id);
          else if (state.cities.length < 5) state.cities.push(c);
          else return toast("最多选 5 座城市");
          invalidateSession();
          paintCities();
          if (state.cities.length)
            void focusPlannerCity(
              state.cities.includes(c) ? c : state.cities.at(-1),
            );
          el.setAttribute(
            "aria-pressed",
            state.cities.some((x) => x.id === c.id),
          );
        }
      };
    } catch (e) {
      if (seq === searchSeq) toast(e.message);
    }
  };
  if (immediate) return work();
  searchTimer = setTimeout(work, 250);
}
function paintCities() {
  $("#selected-cities").innerHTML = state.cities
    .map(
      (c, i) =>
        `<button class="chip" data-remove="${i}" aria-label="移除${esc(c.name)}">${i + 1} · ${esc(c.name)} ×</button>`,
    )
    .join("");
  $("#selected-cities").onclick = (e) => {
    const b = e.target.closest("[data-remove]");
    if (b) {
      state.cities.splice(Number(b.dataset.remove), 1);
      invalidateSession();
      paintCities();
      if (state.cities.length) void focusPlannerCity(state.cities.at(-1));
      searchCities($("#city-search").value, false, true);
    }
  };
}
async function locate(silent) {
  const button = $("#locate"),
    original = state.origin;
  if (!button || button.disabled) return;
  button.disabled = true;
  button.textContent = "正在找你的位置…";
  $("#form-error").textContent = "";
  try {
    const coords = await currentPosition();
    const r = await api(`/api/nearby?lat=${coords.lat}&lng=${coords.lng}`);
    if (!$("#wizard").open || state.step !== 0 || state.origin !== original)
      return;
    state.origin = { label: r.place?.name || "当前位置", ...coords };
    originCity = { ...r.place, ...state.origin, name: state.origin.label };
    void focusPlannerCity(originCity, false);
    invalidateSession();
    $("#origin").value = state.origin.label;
    button.textContent = "◎ 已定位，可修改";
  } catch (e) {
    if (state.step === 0 && !silent) $("#form-error").textContent = e.message;
    button.textContent = "◎ 用当前位置";
  } finally {
    button.disabled = false;
  }
}
function renderClusters(city) {
  const data = state.catalog[city.id],
    selected = (state.selections[city.id] ||= data.clusters
      .filter((g) => g.members.some((p) => p.wanted))
      .map((g) => g.id));
  data.clusters.forEach((c, i) => {
    c.number ||= i + 1;
  });
  const groups = data.clusters.filter(
    (c) => !state.district || c.districts.includes(state.district),
  );
  const shown = groups.slice(0, state.limit);
  $("#question").onclick = null;
  $("#question").innerHTML =
    heading("PICK YOUR PATCH", city.name + "，想逛哪一片？") +
    `<select id="district" class="district-filter" aria-label="选择区县"><option value="">整座城市</option>${data.boundary.districts.map((d) => `<option value="${esc(d.name)}" ${d.name === state.district ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select><div class="clusters">${shown.map((c) => `<article class="cluster ${selected.includes(c.id) ? "selected" : ""}"><button class="cluster-main" data-cluster="${c.id}" aria-pressed="${selected.includes(c.id)}"><div><b>${c.number} · ${esc(c.name)}</b><small>${c.memberCount} 处 · 综合 ${c.score} 分${c.districts.length ? " · " + esc(c.districts[0]) : ""}</small></div><span class="check">${selected.includes(c.id) ? "✓" : "+"}</span></button><details data-members="${c.id}"><summary>看看这些地方</summary><div class="member-list"></div></details></article>`).join("")}</div>${!groups.length ? '<p class="muted">这里暂时没有可选景点，试试其他区县。</p>' : ""}`;
  const inventory = data.inventory;
  if (inventory) {
    const info = document.createElement("p");
    info.className = "muted";
    info.textContent = `${inventory.clusterCount} 片 · ${inventory.placeCount} 处可选地点${inventory.childCount ? ` · 含 ${inventory.childCount} 个子景点` : ""} · 点亮「想去」优先安排`;
    $(".clusters").before(info);
  }
  function showMembers(details, limit = 30) {
    const c = data.clusters.find((g) => g.id === details.dataset.members);
    details.dataset.limit = limit;
    details.querySelector(".member-list").innerHTML =
      byScore(c.members).slice(0, limit).map(scenicMemberMarkup).join("") +
      (c.members.length > limit
        ? '<button class="loadmore" data-more-members>更多景点 ↓</button>'
        : "");
  }
  for (const details of document.querySelectorAll("[data-members]"))
    details.ontoggle = () => {
      if (details.open && !details.dataset.limit) showMembers(details);
    };
  $("#district").onchange = (e) => {
    state.district = e.target.value;
    state.limit = 24;
    renderClusters(city);
  };
  $("#more-clusters")?.addEventListener("click", () => {
    state.limit += 24;
    const y = $("#question").scrollTop;
    renderClusters(city);
    $("#question").scrollTop = y;
  });
  $("#question").onclick = async (e) => {
    const more = e.target.closest("[data-more-members]");
    if (more) {
      const details = more.closest("[data-members]");
      showMembers(details, Number(details.dataset.limit) + 30);
      return;
    }
    const c = e.target.closest("[data-cluster]");
    if (c) {
      const id = c.dataset.cluster,
        i = selected.indexOf(id);
      if (i >= 0) selected.splice(i, 1);
      else if (selected.length < 30) selected.push(id);
      else return toast("每座城市最多选 30 片");
      const y = $("#question").scrollTop;
      renderClusters(city);
      $("#question").scrollTop = y;
      return;
    }
    const v = e.target.closest("[data-wanted]");
    if (v) {
      const group = data.clusters.find((g) =>
        g.members.some(
          (p) =>
            p.id === v.dataset.wanted ||
            p.children?.some((c) => c.id === v.dataset.wanted),
        ),
      );
      const p = group.members
        .flatMap((p) => [p, ...(p.children || [])])
        .find((p) => p.id === v.dataset.wanted);
      v.disabled = true;
      try {
        await api(`/api/journey/sessions/${state.session.id}/wishes`, {
          placeId: p.id,
          wanted: !p.ownWanted,
        });
        p.ownWanted = !p.ownWanted;
        for (const parent of group.members) {
          for (const child of parent.children || [])
            child.wanted = Boolean(child.ownWanted);
          parent.wanted = Boolean(
            parent.ownWanted || parent.children?.some((c) => c.wanted),
          );
        }
        if (p.ownWanted && !selected.includes(group.id)) {
          selected.push(group.id);
          const hint = $(".cluster-hint");
          hint.textContent = hint.textContent.replace(
            /已选 \d+ 片|编号对应下方片区，圆点为代表景点/,
            `已选 ${selected.length} 片`,
          );
          document
            .querySelectorAll(`[data-cluster="${group.id}"]`)
            .forEach((b) => b.setAttribute("aria-pressed", "true"));
          const card = v.closest(".cluster");
          card.classList.add("selected");
          card.querySelector(".check").textContent = "✓";
          toast("已选中这个片区，优先安排想去的地方");
        }
        v.setAttribute("aria-pressed", p.ownWanted);
        v.textContent = p.ownWanted ? "想去 ♥" : "想去 ♡";
        publishPlanner();
      } catch (e) {
        toast(e.message);
      } finally {
        v.disabled = false;
      }
    }
  };
  publishPlanner();
  $("#question").onkeydown = (e) => {
    if (["Enter", " "].includes(e.key) && e.target.matches("g[data-cluster]")) {
      e.preventDefault();
      e.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  };
}
$("#next").onclick = async () => {
  if (state.busy) return;
  const revision = pageRevision;
  try {
    const s = state.step;
    if (s === 0 && !state.origin.label.trim()) throw Error("先填一下出发地吧");
    if (s === 1 && !state.cities.length) throw Error("先选一座想去的城市吧");
    if (s === 2) {
      if (!state.start || !state.end || state.end < state.start)
        throw Error("选好出发和返回日期吧");
      const days =
        (Date.parse(state.end) - Date.parse(state.start)) / 86400000 + 1;
      if (days < state.cities.length || days > 30)
        throw Error("每座城市至少留一天，整趟旅行最多 30 天");
      if (!state.session) {
        setBusy(true, "装好旅行纸签…");
        state.session = await api("/api/journey/sessions", {
          origin: state.origin,
          cityIds: state.cities.map((c) => c.id),
          ...(state.inspiration?.postId?{sourcePostId:state.inspiration.postId}:{}),
          start: state.start,
          end: state.end,
        });
        if (revision !== pageRevision || !$("#wizard").open) {
          setBusy(false);
          return;
        }
        setBusy(false);
      }
    }
    if (s >= 3 && s < 3 + state.cities.length) {
      const city = state.cities[s - 3];
      if (!state.selections[city.id]?.length)
        throw Error("至少选一个想逛的片区吧");
      if (s === 2 + state.cities.length && !state.questions.length) {
        setBusy(true, "再了解你一点点…");
        const q = await api(
          `/api/journey/sessions/${state.session.id}/questions`,
          {},
        );
        if (revision !== pageRevision || !$("#wizard").open) {
          setBusy(false);
          return;
        }
        state.questions = q.questions;
        state.answers = { ...state.answers, ...q.defaults };
        setBusy(false);
      }
    }
    if (
      state.questions.length &&
      s === 2 + state.cities.length + state.questions.length
    ) {
      setBusy(true, "把喜欢的地方排成一路…");
      const trip = await api(
        `/api/journey/sessions/${state.session.id}/generate`,
        { selections: state.selections, answers: state.answers },
      );
      if (revision !== pageRevision || !$("#wizard").open) {
        setBusy(false);
        return;
      }
      setBusy(false);
      closeWizard();
      await showTrip(trip);
      toast("行程已保存，可点击标题右侧分享");
      state.session = null;
      state.step = 0;
      state.catalog = {};
      state.questions = [];
      state.selections = {};
      state.inspiration = null;
      return;
    }
    await turn(s + 1);
  } catch (e) {
    setBusy(false);
    await render();
    $("#form-error").textContent = e.message;
  }
};
$("#back").onclick = () => turn(Math.max(0, state.step - 1));
$("#close").onclick = () => {
  if (state.busy) return toast("正在处理，请稍等一下");
  closeWizard();
};
$("#begin").onclick = async () => {
  try {
    await ensureUser();
    workspace("planner");
    plannerMap = null;
    plannerCity = null;
    $("#wizard").show();
    paintMap();
    await render();
  } catch (e) {
    toast(e.message);
  }
};
async function adoptSocialRoute(post){
  const cities=[];
  for(const name of [...new Set(post.snapshot?.cities||[])].slice(0,5)){
    const list=await api('/api/places?category=city&q='+encodeURIComponent(name));
    const exact=uniqueCities(list.filter(c=>c.name.replace(/市$/,'')===name.replace(/市$/,'')));
    if(exact.length!==1)throw Error('目的城市需重新确认，请从旅行页选择');cities.push(exact[0]);
  }
  if(!cities.length)throw Error('这条分享没有可用的目的城市');
  await api('/api/social/posts/'+post.id+'/adopt',{});
  invalidateSession();state.cities=cities;state.start='';state.end='';state.step=0;
  state.inspiration={postId:post.id,placeIds:[...new Set((post.snapshot.days||[]).flatMap(d=>d.stops||[]).map(p=>p.id))]};
  navigation.go('/home');await $('#begin').onclick();
  toast('已带入路线地点，请确认你的出发地和日期');
}
function mapPayload() {
  const day = state.trip?.plan.days[state.day];
  const stops = (day?.stops || []).filter(hasPosition).map((p) => mapPoint(p));
  const cities = overviewPoints(state.trip);
  return {
    type: "seatraces-overview",
    tripId: state.trip?.id,
    cityContext: state.trip?.plan.cities.find((c) => c.id === day?.cityId),
    contextKey: `trip:${state.trip?.id || "home"}:${state.mapView}:${state.day}`,
    view: state.mapView,
    day: state.day,
    fitKey: `${state.trip?.id || "home"}:${state.fitRevision}`,
    // The itinerary now sits below the map, so it cannot obscure route bounds.
    viewPadding: [70, 35, 35, 35],
    cities,
    stops,
    services:
      state.mapView === "day" ? savedServicePoints(state.trip, state.day) : [],
    connections: schematicConnections(stops),
    cityConnections: schematicConnections(cities),
    segments: [],
    days: (state.trip?.plan.days || [])
      .map((d, i) => ({
        index: i,
        cityId: d.cityId,
        position: state.trip.plan.cities.find((c) => c.id === d.cityId),
      }))
      .filter((d) => hasPosition(d.position))
      .map((d) => ({ ...d, position: mapPoint(d.position).position })),
  };
}
function paintMap({ preserveCamera = false } = {}) {
  let payload = mapPayload();
  if ($("#wizard").open)
    payload = plannerMap || {
      type: "seatraces-overview",
      kind: "planner",
      view: "day",
      lockView: true,
      segments: [],
      contextKey: "planner:blank",
      fitKey: "planner:blank",
    };
  else if (serviceMap)
    payload = serviceScene(
      payload,
      serviceMap.slot,
      serviceMap.id,
      serviceMap.focusRevision,
    );
  if (preserveCamera) payload.preserveCamera = true;
  $("#travel-map").contentWindow.postMessage(payload, location.origin);
}
function workspaceHeight() {
  document.documentElement.style.setProperty(
    "--workspace-height",
    (window.visualViewport?.height || innerHeight) + "px",
  );
}
window.visualViewport?.addEventListener("resize", workspaceHeight);
window.addEventListener("resize", workspaceHeight);
workspaceHeight();
{
  const home = $("#home");
  const stage = home.querySelector(".map-stage");
  const grip = $("#map-grip");
  const handles = [grip, $("#wizard .paper-tools")].filter(Boolean);
  let drag = null;
  function bounds() {
    const height = home.clientHeight;
    const minimum = Math.min(120, height * 0.3);
    // Keep the questionnaire header, choices and next button reachable.
    const maximum = Math.max(minimum, Math.min(height * 0.78, height - grip.offsetHeight - 220));
    return { height, minimum, maximum };
  }
  function resizeMap(pixels) {
    const { height, minimum, maximum } = bounds();
    if (!height) return;
    const size = Math.max(minimum, Math.min(maximum, pixels));
    stage.style.flexBasis = `${(size / height) * 100}%`;
    grip.setAttribute("aria-valuemin", Math.round(minimum / height * 100));
    grip.setAttribute("aria-valuemax", Math.round(maximum / height * 100));
    grip.setAttribute("aria-valuenow", Math.round(size / height * 100));
    grip.setAttribute("aria-valuetext", `地图占 ${Math.round(size / height * 100)}%`);
  }
  for (const handle of handles) {
    handle.addEventListener("pointerdown", (event) => {
      if (!home.classList.contains("map-workspace") || drag || !event.isPrimary || event.button !== 0 ||
          event.target.closest("button, a, input, select, textarea")) return;
      event.preventDefault();
      drag = { pointerId: event.pointerId, y: event.clientY, height: stage.getBoundingClientRect().height };
      handle.setPointerCapture(event.pointerId);
      home.classList.add("resizing-map");
    });
    handle.addEventListener("pointermove", (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      resizeMap(drag.height + event.clientY - drag.y);
    });
    const stop = (event) => {
      if (drag?.pointerId !== event.pointerId) return;
      drag = null;
      home.classList.remove("resizing-map");
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(type, stop);
  }
  grip.addEventListener("keydown", (event) => {
    if (!home.classList.contains("map-workspace")) return;
    const { minimum, maximum } = bounds();
    const height = stage.getBoundingClientRect().height;
    const sizes = { ArrowUp: height - 24, ArrowDown: height + 24, Home: minimum, End: maximum };
    if (!(event.key in sizes)) return;
    event.preventDefault();
    resizeMap(sizes[event.key]);
  });
  new ResizeObserver(() => {
    if (home.classList.contains("map-workspace") && home.clientHeight) resizeMap(stage.getBoundingClientRect().height);
  }).observe(home);
}

window.addEventListener("message", (e) => {
  if (
    e.origin !== location.origin ||
    e.source !== $("#travel-map").contentWindow
  )
    return;
  if (e.data?.type === "seatraces-map-ready") paintMap();
  if (e.data?.type === "seatraces-service-pick") {
    if (serviceDock) void serviceDock.select(e.data.id, true);
    else if (state.trip && !$("#wizard").open) {
      const p = savedServicePoints(state.trip, state.day).find(
        (p) => p.id === e.data.id,
      );
      if (p)
        navigation.go(
          `/services/${state.trip.id}?day=${state.day}&slot=${encodeURIComponent(p.slotId)}`,
        );
    }
  }
  if (e.data?.type === "seatraces-cluster-pick" && $("#wizard").open) {
    const button = [
      ...document.querySelectorAll("#question [data-cluster]"),
    ].find((b) => b.dataset.cluster === e.data.id);
    if (button) {
      button.click();
      const next = [
        ...document.querySelectorAll("#question [data-cluster]"),
      ].find((b) => b.dataset.cluster === e.data.id);
      next?.scrollIntoView({
        block: "nearest",
        behavior: reducedMotion() ? "auto" : "smooth",
      });
    }
  }
  if (
    e.data?.type === "seatraces-map-view" &&
    state.trip &&
    !$("#wizard").open &&
    !serviceDock
  ) {
    state.mapView = e.data.view === "overview" ? "overview" : "day";
    if (Number.isInteger(e.data.day) && state.trip.plan.days[e.data.day])
      state.day = e.data.day;
    paintTrip(false);
    paintMap({ preserveCamera: true });
  }
});
async function resolveOrigin(trip) {
  let origin = trip.request.origin;
  if (hasPosition(origin)) return;
  const label = typeof origin === "string" ? origin : origin?.label;
  if (!label) return;
  try {
    const cities = await api(
      "/api/places?category=city&q=" + encodeURIComponent(label),
    );
    const matches = cities.filter(
      (c) => c.name.replace(/市$/, "") === label.trim().replace(/市$/, ""),
    );
    const distinct = new Map(
      matches.map((c) => [c.country + ":" + c.province + ":" + c.name, c]),
    );
    if (distinct.size === 1) {
      const c = [...distinct.values()][0];
      trip.request.origin = { label, lat: c.lat, lng: c.lng };
    }
  } catch {
    /* Keep an unknown origin unknown; never invent a route endpoint. */
  }
}
async function showTrip(trip) {
  state.trip = trip;
  state.day = 0;
  state.mapView = "overview";
  state.fitRevision++;
  localStorage.setItem("seatraces-last-trip", trip.id);
  paintTrip();
  $("#home").scrollTo({ top: 0, behavior: "smooth" });
  await resolveOrigin(trip);
  if (state.trip?.id === trip.id) {
    state.fitRevision++;
    paintTrip();
  }
}
function navigationHtml(day) {
  if (!day.stops.length) return "";
  const url = amapLegUrl(null, day.stops[0], state.trip.request.transport);
  return `<div class="navigation-action"><select id="navigation-leg" aria-label="选择导航目的地">${day.stops.map((p, i) => `<option value="${i}">${i ? esc(day.stops[i - 1].name) : "当前位置"} → ${esc(p.name)}</option>`).join("")}</select>${url ? `<a id="open-amap" class="navigation-link" href="${esc(url)}" rel="noopener">高德导航 ↗</a>` : ""}</div>`;
}
function paintTrip(updateMap = true) {
  const t = state.trip,
    d = t.plan.days[state.day],
    overview = state.mapView === "overview";
  $("#itinerary").hidden = false;
  $("#itinerary").innerHTML =
    `<div class="trip-head"><h2>${esc(t.title)}</h2><button id="publish-trip" class="route-share" type="button" aria-label="发布这份行程到发现">分享 ↗</button></div>
    <div class="days"><button class="day" data-overview aria-pressed="${overview}">旅行总览</button>${t.plan.days.map((d, i) => `<button class="day" data-day="${i}" aria-pressed="${!overview && i === state.day}">Day ${i + 1} · ${esc(d.city)}</button>`).join("")}</div>
    <div class="stopline">${overview ? [typeof t.request.origin === "string" ? t.request.origin : t.request.origin?.label, ...t.plan.cities.map((c) => c.name)].filter(Boolean).map(esc).join(" → ") : d.stops.map((p, i) => `${i + 1}. ${esc(p.name)}`).join(" → ") || "自由时光"}</div>
    <p class="muted">${overview ? `${esc(t.request.start)} — ${esc(t.request.end)}` : esc(d.date)}${!overview && d.transferAllowance ? " · 跨城日，已预留交通时间" : ""}</p>
    ${overview ? (!hasPosition(t.request.origin) ? '<p class="muted">出发地待定位，先展示目的城市</p>' : "") : navigationHtml(d)}`;
  const missing = t.plan.wishes?.unscheduled || [];
  if (missing.length) {
    const detail = document.createElement("details");
    detail.className = "notice";
    detail.innerHTML = `<summary>${missing.length} 处想去的地方待安排</summary>${missing.map((p) => `<p>${esc(p.name)} · ${p.reason === "closed_on_selected_dates" ? "所选日期不开放" : "这趟时间有限"}</p>`).join("")}`;
    $("#itinerary").append(detail);
  }
  if (!overview) {
    const record = document.createElement("button");
    record.id = "record-presence";
    record.className = "inline-action";
    record.textContent = presence.isEnabled() ? "到访记录中 ◎" : "记录到访 ◎";
    record.setAttribute("aria-pressed", presence.isEnabled());
    $("#itinerary").append(record);
    $("#navigation-leg")?.addEventListener("change", (e) => {
      const i = Number(e.target.value),
        link = $("#open-amap");
      const url = amapLegUrl(
        i ? d.stops[i - 1] : null,
        d.stops[i],
        t.request.transport,
      );
      if (link && url) link.href = url;
    });
  }
  $("#itinerary").onclick = (e) => {
    const publish = e.target.closest("#publish-trip");
    if (publish) {
      void publishRoute({ button: publish, kind: "journey", id: t.id, api, navigate: path => navigation.go(path), toast });
      return;
    }
    if (e.target.closest("#record-presence")) {
      presence.toggle();
      return;
    }
    const day = e.target.closest("[data-day]"),
      all = e.target.closest("[data-overview]");
    if (day || all) {
      state.mapView = all ? "overview" : "day";
      if (day) state.day = Number(day.dataset.day);
      state.fitRevision++;
      paintTrip();
      $("#home").scrollTo({ top: 0, behavior: "smooth" });
    }
  };
  if (updateMap) paintMap();
  const services = document.createElement("section");
  $("#itinerary").append(services);
  if (!overview)
    mountTripServices({
      element: services,
      trip: t,
      day: state.day,
      api,
      navigate: (path) => navigation.go(path),
    });
}
let districtRefresh;
function refreshDistricts(city) {
  clearTimeout(districtRefresh);
  if (state.catalog[city.id]?.boundary.status !== "loading") return;
  const sessionId = state.session.id;
  districtRefresh = setTimeout(async () => {
    if (
      !$("#wizard").open ||
      state.cities[state.step - 3]?.id !== city.id ||
      state.session?.id !== sessionId
    )
      return;
    try {
      const r = await api(
        `/api/journey/sessions/${sessionId}/cities/${encodeURIComponent(city.id)}/boundary`,
      );
      const data = state.catalog[city.id];
      if (!data) return;
      data.boundary = r.boundary;
      for (const g of data.clusters) g.districts = r.districts[g.id] || [];
      // Refresh only the map/filter: leave expanded sights and scroll untouched.
      if (state.cities[state.step - 3]?.id === city.id) {
        const selected = state.selections[city.id] || [];
        publishPlanner();
        $("#district").innerHTML =
          '<option value="">整座城市</option>' +
          data.boundary.districts
            .map(
              (d) => `<option value="${esc(d.name)}">${esc(d.name)}</option>`,
            )
            .join("");
        $("#district").value = state.district;
      }
      refreshDistricts(city);
    } catch {
      /* A district detail failure must not hide existing scenic choices. */
    }
  }, 4000);
}
$("#account").onclick = () => selectPage("account");
$("#history").onclick = () => selectPage("history");
async function boot() {
  try {
    me = await api("/api/me");
    syncProfile();
    document.body.classList.remove("auth-pending");
    $("#auth-loading").hidden = true;
    navigation.start();
    $("#travel-map").src = $("#travel-map").dataset.src;
    const bootRevision = pageRevision;
    const last = localStorage.getItem("seatraces-last-trip");
    if (me.user && last && !location.hash.startsWith("#/services/")) {
      try {
        const t = await api("/api/trips/" + encodeURIComponent(last));
        if (
          t.plan.schemaVersion === "journey/2" &&
          bootRevision === pageRevision &&
          !$("#wizard").open
        )
          await showTrip(t);
      } catch {
        localStorage.removeItem("seatraces-last-trip");
      }
    }
  } catch {
    $("#auth-loading span").textContent = "暂时连不上服务，请稍后重试";
    $("#auth-retry").hidden = false;
  }
}
$("#auth-retry").onclick = boot;
window.addEventListener("pageshow", (e) => {
  if (e.persisted && me?.user) void ensureUser().catch(() => {});
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && me?.user) void ensureUser().catch(() => {});
});
void boot();
