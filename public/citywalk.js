import {renderWalkEditor} from './citywalk-editor.js';
import {renderClassicWalk} from './classic-walk-view.js';
import { publishRoute } from "./discovery.js";
import { classicWalks, loadClassicWalks } from "./citywalk-classics.js";

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function walkArt(motif) {
  const landmark =
    motif === "gate"
      ? '<path d="M160 78h118v57H160z" fill="#ffb597"/><path d="m151 78 68-33 68 33z" fill="#e67f68"/><path d="M205 135v-27a14 14 0 0 1 28 0v27" fill="#fff8df"/><path d="m168 58 51-24 51 24" fill="none"/>'
      : motif === "lake"
        ? '<path d="m140 124 30-70 29 50 25-62 48 82" fill="#8acdac"/><path d="m228 89 29-16 29 16z" fill="#e99476"/><path d="M239 89v31m34-31v31"/><path d="M149 140q60-20 128 0" fill="none" stroke="#57bfb7"/>'
        : '<path d="M152 128V66h12v62m101 0V66h12v62" fill="#fff9e7"/><path d="M164 74q50 62 101 0M152 128h125M184 96v32m25-23v23m25-26v26" fill="none"/><path d="m168 137 92 0" stroke="#54b3b4"/>';
  return `<svg class="walk-art" viewBox="0 0 320 170" aria-hidden="true"><circle cx="274" cy="36" r="18" fill="#ffcf63"/><path d="M12 135Q60 91 83 121T155 149T298 145" fill="none" stroke="#fffdf2" stroke-width="15"/><path d="M12 135Q60 91 83 121T155 149T298 145" fill="none" stroke="#1c655e" stroke-width="2" stroke-dasharray="5 7"/><g stroke="#183c40" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${landmark}<path d="M64 115V87m-12 19q-22-30 0-37 26-9 25 25" fill="#65bd96"/><circle cx="83" cy="121" r="7" fill="#ffda73"/><circle cx="155" cy="149" r="7" fill="#fffdf2"/><path d="m22 42 5-9 5 9-5 9zM102 40h9m-4-4v8" fill="#fffdf2"/></g></svg>`;
}

export function createCityWalkHome({ api, navigate, toast, authenticated=()=>true }) {
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
        `<article class="walk-slide ${w.theme}" aria-label="${i + 1} / ${classicWalks.length} · ${esc(w.city)}"><button data-classic="${w.id}" class="classic-open"><span class="walk-city">${esc(w.city)} <span aria-hidden="true">↗</span></span>${walkArt(w.motif)}<div class="walk-caption"><h3>${esc(w.title)}</h3><b>${w.stops.length} 站${Number.isFinite(w.distance_m)?' · '+(w.distance_m/1000).toFixed(1)+' 公里':''}</b><p>${w.stops.map(esc).join(" → ")}</p></div></button></article>`,
    )
    .join("");
  dots.innerHTML = classicWalks
    .map(
      (w, i) =>
        `<button data-walk-dot="${i}" aria-label="查看${esc(w.city)}${esc(w.title)}" aria-current="${i === 0}"></button>`,
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
    if(!authenticated()){list.replaceChildren();more.hidden=true;return;}
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

export async function renderCityWalkEditor(options){return options.route.id?.startsWith('classic-')?renderClassicWalk(options):renderWalkEditor(options);}
