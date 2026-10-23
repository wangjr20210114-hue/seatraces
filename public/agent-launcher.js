/* 创建问 AI 入口，传递当前页面的旅行上下文。 */

export function mountAgentLauncher(button) {
  const storageKey = "seatraces:ai-position:v1";
  button.innerHTML =
    '<span class="ai-spark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M16 3c1 8 5 12 13 13-8 1-12 5-13 13C15 21 11 17 3 16 11 15 15 11 16 3Z"/><circle cx="12" cy="15" r="1.2"/><circle cx="20" cy="15" r="1.2"/><path class="ai-smile" d="M13 19q3 3 6 0"/></svg></span><span>问 AI</span>';
  button.title = "问 AI · 可拖动，Alt + 方向键移动";
  let drag,
    saved,
    suppressUntil = 0;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey));
  } catch {}
  function bounds() {
    return {
      x: Math.max(12, innerWidth - button.offsetWidth - 12),
      y: Math.max(76, innerHeight - button.offsetHeight - 90),
    };
  }
  function move(x, y) {
    const b = bounds();
    const next = {
      x: Math.max(12, Math.min(x, b.x)),
      y: Math.max(76, Math.min(y, b.y)),
    };
    button.style.left = next.x + "px";
    button.style.top = next.y + "px";
    button.style.right = "auto";
    button.style.bottom = "auto";
    return next;
  }
  function remember() {
    const r = button.getBoundingClientRect(),
      b = bounds();
    saved = { x: r.left / b.x, y: r.top / b.y };
    try {
      localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch {}
  }
  function restore() {
    if (
      !button.offsetWidth ||
      !Number.isFinite(saved?.x) ||
      !Number.isFinite(saved?.y)
    )
      return;
    const b = bounds();
    move(saved.x * b.x, saved.y * b.y);
  }
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = button.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      left: r.left,
      top: r.top,
      moved: false,
    };
    button.setPointerCapture(e.pointerId);
  });
  button.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 6) return;
    drag.moved = true;
    button.classList.add("dragging");
    move(drag.left + dx, drag.top + dy);
  });
  const finish = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.moved) {
      suppressUntil = performance.now() + 350;
      remember();
    }
    drag = null;
    button.classList.remove("dragging");
  };
  button.addEventListener("pointerup", finish);
  button.addEventListener("pointercancel", finish);
  button.addEventListener(
    "click",
    (e) => {
      if (performance.now() < suppressUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  button.addEventListener("keydown", (e) => {
    const delta = {
      ArrowLeft: [-20, 0],
      ArrowRight: [20, 0],
      ArrowUp: [0, -20],
      ArrowDown: [0, 20],
    }[e.key];
    if (!e.altKey || !delta) return;
    e.preventDefault();
    const r = button.getBoundingClientRect();
    move(r.left + delta[0], r.top + delta[1]);
    remember();
  });
  addEventListener("resize", restore);
  addEventListener("hashchange", () => requestAnimationFrame(restore));
  requestAnimationFrame(restore);
  const observer = new MutationObserver(() => requestAnimationFrame(restore));
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
