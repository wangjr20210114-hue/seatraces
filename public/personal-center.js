import { libraryCard, bindCardActions } from './social-ui.js';
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (s) => (s ? new Date(s).toLocaleDateString("zh-CN") : "");
export async function refreshPersonalOverview({ element, api, isCurrent }) {
  element.innerHTML = '<p role="status">正在整理…</p>';
  try {
    const d = await api("/api/me/overview");
    if (!isCurrent()) return;
    element.innerHTML = [
      ["history", d.trips, "行程"],
      ["walks", d.walks, "CityWalk"],
    ]
      .map(
        ([path, n, label]) =>
          `<a href="#/${path}"><b>${n}</b><span>${label}</span></a>`,
      )
      .join("");
  } catch (e) {
    if (isCurrent()) {
      element.innerHTML = '<button class="walk-create">重新加载</button>';
      element.querySelector("button").onclick = () =>
        refreshPersonalOverview({ element, api, isCurrent });
    }
  }
}
export async function renderPersonalPage({
  route,
  content,
  setTitle,
  api,
  isCurrent,
  navigate,
}) {
  const names = {
    walks: "我的 CityWalk",
    favorites: "我的收藏",
    browsing: "历史浏览",
    report: "旅行报告",
    style: "旅行偏好",
    security: "账号安全",
    help: "帮助与关于",
  };
  setTitle(names[route.page]);
  content.className = "personal-page";
  content.innerHTML = '<p class="page-status" role="status">正在打开…</p>';
  const $ = (s) => content.querySelector(s);
  const fail = (e) => {
    if (isCurrent()) {
      const el = $("[role=status]");
      if (el) el.textContent = e.message;
    }
  };
  try {
    if (["favorites", "browsing"].includes(route.page) && route.id) {
      const p = await api(
        `/api/me/library/${route.page}/${encodeURIComponent(route.id)}`,
      );
      if (!isCurrent()) return;
      content.innerHTML = `<article class="personal-letter"><h2>${esc(p.title)}</h2><p class="personal-body">${esc(p.body)}</p>${(p.snapshot?.days || []).map((d) => `<section><h3>${esc(d.city || "路线")}</h3><ol>${(d.stops || []).map((s) => `<li>${esc(s.name)}</li>`).join("")}</ol></section>`).join("")}</article>`;
      return;
    }
    if (["favorites", "browsing", "walks"].includes(route.page)) {
      const browsing = route.page === "browsing",
        walks = route.page === "walks";
      content.innerHTML = `<div class="personal-actions">${walks ? '<a class="primary" href="#/citywalk/new">画一条新路线 ↗</a>' : browsing ? '<button class="walk-create" id="clear-browsing">清空浏览记录</button>' : ""}</div><div class="history-list"></div><p role="status"></p><button class="loadmore" hidden>更多 ↓</button>`;
      let offset = 0;
      const list = $(".history-list"),
        more = $(".loadmore"),
        status = $("[role=status]");
      if (!walks) {
        list.classList.add('social-feed');
        bindCardActions(list, { api, toast: message => fail({ message }) });
      }
      const load = async () => {
        more.disabled = true;
        try {
          const r = await api(
            walks
              ? `/api/citywalks?limit=21&offset=${offset}`
              : `/api/me/library/${route.page}?limit=20&offset=${offset}`,
          );
          if (!isCurrent()) return;
          const items = walks ? r.slice(0, 20) : r.items;
          list.insertAdjacentHTML(
            "beforeend",
            items
              .map(
                (p) =>
                  !walks ? libraryCard(p, route.page).replace('</article>', `${route.page === "favorites" ? `<button class="social-subtle library-unsave" data-unsave="${esc(p.id)}">取消收藏</button>` : ''}</article>`) :
                  `<article class="personal-list-item" data-item="${esc(p.id)}"><a href="#/citywalk/${encodeURIComponent(p.id)}"><b>${esc(p.title)}</b><span>${esc(p.city.name)} · ${p.stops.length} 站</span></a></article>`,
              )
              .join(""),
          );
          offset += items.length;
          more.hidden = walks ? r.length <= 20 : !r.hasMore;
          status.textContent = offset
            ? ""
            : walks
              ? "还没有自己的路线"
              : browsing
                ? "还没有浏览记录"
                : "还没有收藏的路线";
        } catch (e) {
          fail(e);
          more.hidden = false;
          more.textContent = "重试";
        } finally {
          more.disabled = false;
        }
      };
      more.onclick = load;
      list.onclick = async (e) => {
        const b = e.target.closest("[data-unsave]");
        if (!b) return;
        b.disabled = true;
        try {
          await api(
            "/api/me/library/favorites/" + encodeURIComponent(b.dataset.unsave),
            undefined,
            "DELETE",
          );
          if (isCurrent()) {
            list.replaceChildren();
            offset = 0;
            await load();
          }
        } catch (e) {
          fail(e);
          b.disabled = false;
        }
      };
      if (browsing)
        $("#clear-browsing").onclick = async (e) => {
          const b = e.currentTarget;
          if (!b.dataset.confirm) {
            b.dataset.confirm = "1";
            b.textContent = "确认清空自己的浏览记录";
            return;
          }
          b.disabled = true;
          try {
            await api("/api/me/history", undefined, "DELETE");
            if (isCurrent()) {
              list.replaceChildren();
              offset = 0;
              await load();
              b.textContent = "清空浏览记录";
              delete b.dataset.confirm;
            }
          } catch (e) {
            fail(e);
          } finally {
            b.disabled = false;
          }
        };
      await load();
      return;
    }
    if (route.page === "report") {
      const r = await api("/api/me/report");
      if (!isCurrent()) return;
      content.innerHTML = `<section class="personal-letter"><span class="personal-emblem">✦</span><h2>我的旅行手账</h2><p>${esc(r.summary)}</p><div class="personal-stats">${[
        [r.completed, "已完成行程"],
        [r.planned, "计划中"],
        [r.walks, "CityWalk"],
        [r.visitedPlaces, "已记录到访"],
      ]
        .map(([n, label]) => `<div><b>${n || 0}</b><span>${label}</span></div>`)
        .join(
          "",
        )}</div><h3>行程里的城市</h3><div class="personal-tags">${r.cities.map((c) => `<span>${esc(c)}</span>`).join("") || "完成行程后点亮"}</div><p>到访只统计已有记录。</p><a class="inline-action" href="#/history">查看历史行程 →</a></section>`;
      return;
    }
    if (route.page === "style") {
      const r = await api("/api/me/style");
      if (!isCurrent()) return;
      content.innerHTML = `<form class="personal-letter" id="style-form"><h2>按自己的步调走</h2>${Object.entries(
        r.options,
      )
        .map(
          ([key, options]) =>
            `<fieldset><legend>${esc(r.labels[key])}</legend><div class="personal-options">${options.map((value) => `<label><input type="${key === "interests" ? "checkbox" : "radio"}" name="${key}" value="${esc(value)}" ${Array.isArray(r.values[key]) ? (r.values[key].includes(value) ? "checked" : "") : r.values[key] === value ? "checked" : ""}><span>${esc(r.valueLabels[value] || value)}</span></label>`).join("")}</div></fieldset>`,
        )
        .join(
          "",
        )}<button class="primary" type="submit">保存偏好 ✓</button><p role="status"></p></form>`;
      $("#style-form").onsubmit = async (e) => {
        e.preventDefault();
        const b = e.currentTarget.querySelector("button"),
          form = new FormData(e.currentTarget);
        b.disabled = true;
        try {
          const values = Object.fromEntries(
            Object.keys(r.options).map((k) => [
              k,
              k === "interests" ? form.getAll(k) : form.get(k),
            ]),
          );
          await api("/api/me/style", { values, versions: r.versions }, "PUT");
          if (!isCurrent()) return;
          const latest = await api("/api/me/style");
          r.versions = latest.versions;
          fail({ message: "已保存，下次规划会参考这些偏好" });
        } catch (e) {
          fail(e);
        } finally {
          b.disabled = false;
        }
      };
      return;
    }
    if (route.page === "security") {
      const r = await api("/api/me/security");
      if (!isCurrent()) return;
      content.innerHTML = `<section class="personal-letter"><h2>账号安全</h2><p>有效登录会话 <b id="session-total">${r.activeSessions}</b></p><form id="password-form"><label class="field">当前密码<input name="currentPassword" type="password" autocomplete="current-password" required minlength="8"></label><label class="field">新密码<input name="newPassword" type="password" autocomplete="new-password" required minlength="8"></label><label class="field">再次输入新密码<input name="repeat" type="password" autocomplete="new-password" required minlength="8"></label><button class="primary">更新密码</button></form><form id="sessions-form"><h3>退出其他登录</h3><label class="field">当前密码<input name="password" type="password" autocomplete="current-password" required minlength="8"></label><button class="account-secondary">退出其他会话</button></form><p role="status"></p></section>`;
      for (const id of ["password", "sessions"])
        $("#" + id + "-form").onsubmit = async (e) => {
          e.preventDefault();
          const f = e.currentTarget,
            b = f.querySelector("button"),
            v = Object.fromEntries(new FormData(f));
          if (id === "password" && v.repeat !== v.newPassword) {
            fail({ message: "两次新密码不一致" });
            return;
          }
          delete v.repeat;
          b.disabled = true;
          try {
            await api(
              "/api/auth/" +
                (id === "password"
                  ? "change-password"
                  : "revoke-other-sessions"),
              v,
            );
            if (!isCurrent()) return;
            f.reset();
            $("#session-total").textContent = "1";
            fail({
              message:
                id === "password"
                  ? "密码已更新，其他会话已退出"
                  : "其他会话已退出",
            });
          } catch (e) {
            fail(e);
          } finally {
            b.disabled = false;
          }
        };
      return;
    }
    content.innerHTML = `<section class="personal-letter"><h2>SeaTraces 海迹</h2><p>把想去的地方，连成自己的旅行。</p><details open><summary>CityWalk 怎么选点？</summary><p>先选城市和步行圈，点选附近地点，连线即时更新。选好后规划步行路线，再保存。</p></details><details><summary>距离以什么为准？</summary><p>选点时是几何连线预览。确认后显示高德步行路程；超过 10 公里提醒，达到 15 公里不能保存。</p></details><details><summary>经典路线能直接进馆吗？</summary><p>路线串联地标；入馆、门票、预约与临时开放安排以场馆公告为准。</p></details><details><summary>记录会保存在哪里？</summary><p>登录后的行程和偏好保存在账号下。游客只能浏览地图和经典路线。浏览记录可以自行清空。</p></details><a class="inline-action" href="#/agent">问 AI 帮我操作 →</a></section>`;
  } catch (e) {
    if (isCurrent()) {
      content.innerHTML =
        '<p role="status"></p><button class="primary">重新加载</button>';
      fail(e);
      $("button").onclick = () =>
        renderPersonalPage({
          route,
          content,
          setTitle,
          api,
          isCurrent,
          navigate,
        });
    }
  }
}
