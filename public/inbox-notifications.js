import { icon } from './ui-icons.js';

export function createInboxNotifications({ api, navigate, interval = 30000 }) {
  let userId = null, generation = 0, timer, pending, loginCheck = false, unread = 0, dialog;
  const shownKey = id => `seatraces:inbox-shown:${id}`;
  const readStorage = key => { try { return sessionStorage.getItem(key); } catch { return null; } };
  const writeStorage = (key, value) => { try { sessionStorage.setItem(key, value); } catch {} };
  function paint() {
    for (const el of document.querySelectorAll('[data-inbox-badge]')) {
      el.hidden = !unread;
      el.textContent = el.dataset.inboxBadge === 'count' && unread ? (unread > 99 ? '99+' : String(unread)) : '';
    }
    for (const el of document.querySelectorAll('[data-inbox-link]'))
      el.setAttribute('aria-label', unread ? `消息，${unread} 条未读` : '消息');
    document.querySelector('[data-page="profile"]')?.setAttribute('aria-label', unread ? `我的，${unread} 条未读站内信` : '我的');
  }
  function close() { dialog?.close(); dialog?.remove(); dialog = null; }
  function schedule() {
    clearTimeout(timer);
    if (userId && !document.hidden) timer = setTimeout(() => void refresh(), interval);
  }
  async function showUnread(ticket, id) {
    const message = await api(`/api/me/messages/${id}`);
    if (ticket !== generation || message.read_at || document.hidden) return false;
    close();
    const el = document.createElement('dialog');
    el.className = 'inbox-welcome';
    el.setAttribute('aria-labelledby', 'inbox-welcome-title');
    el.innerHTML = `<div class="inbox-welcome-heading"><span class="menu-icon mint">${icon('mail')}</span><span>你有新消息</span><button class="round" data-dismiss aria-label="稍后阅读">${icon('close')}</button></div><p class="muted" data-unread></p><h2 id="inbox-welcome-title"></h2><time></time><div class="inbox-body"></div><p role="status"></p><div class="inbox-welcome-actions"><button class="inline-action" data-all>全部消息 ${icon('arrow')}</button><button class="primary" data-read>我已阅读 ${icon('check')}</button></div>`;
    el.querySelector('[data-unread]').textContent = `还有 ${unread} 条未读站内信`;
    el.querySelector('h2').textContent = message.title;
    el.querySelector('time').textContent = new Date(message.created_at).toLocaleString('zh-CN');
    el.querySelector('.inbox-body').textContent = message.body;
    el.querySelector('[data-dismiss]').onclick = close;
    el.addEventListener('cancel', e => { e.preventDefault(); close(); });
    el.querySelector('[data-all]').onclick = () => { close(); navigate('/messages'); };
    el.querySelector('[data-read]').onclick = async e => {
      e.currentTarget.disabled = true;
      try {
        await api(`/api/me/messages/${id}/read`, {});
        if (ticket !== generation || dialog !== el) return;
        close();
        changed();
      } catch (error) {
        if (dialog === el) {
          el.querySelector('[role="status"]').textContent = error.message;
          el.querySelector('[data-read]').disabled = false;
        }
      }
    };
    document.body.append(el);
    dialog = el;
    el.showModal();
    writeStorage(shownKey(userId), '1');
    return true;
  }
  async function refresh() {
    paint();
    if (!userId || document.hidden) return;
    if (pending) return pending;
    const ticket = generation;
    const work = (async () => {
      try {
        const result = await api('/api/me/messages?limit=1&unread=1');
        if (ticket !== generation || (result.userId && result.userId !== userId)) return;
        unread = result.unread;
        paint();
        if (loginCheck) {
          if (!unread || readStorage(shownKey(userId))) loginCheck = false;
          else if (result.items[0] && await showUnread(ticket, result.items[0].id)) loginCheck = false;
        }
      } catch { /* Keep the last known badge; retry on visibility/connection or the next interval. */ }
      finally { if (ticket === generation) { pending = null; schedule(); } }
    })();
    pending = work;
    return work;
  }
  function changed() {
    // Wait out an earlier poll so its pre-read count cannot overwrite the update.
    const ticket = generation;
    void Promise.resolve(pending).then(() => { if (ticket === generation) void refresh(); });
    try { localStorage.setItem('seatraces:inbox-changed', String(Date.now())); } catch {}
  }
  function setUser(user) {
    const next = user?.id || null;
    if (next === userId) { paint(); return; }
    generation++;
    clearTimeout(timer);
    pending = null;
    close();
    userId = next;
    unread = 0;
    loginCheck = !!next;
    if (next && readStorage('seatraces:inbox-login')) {
      try { sessionStorage.removeItem(shownKey(next)); sessionStorage.removeItem('seatraces:inbox-login'); } catch {}
    }
    paint();
    void refresh();
  }
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden) void refresh(); });
  window.addEventListener('focus', () => void refresh());
  window.addEventListener('online', () => void refresh());
  window.addEventListener('storage', e => { if (e.key === 'seatraces:inbox-changed') void refresh(); });
  document.addEventListener('seatraces:inbox-read', changed);
  return { setUser, refresh, paint };
}
