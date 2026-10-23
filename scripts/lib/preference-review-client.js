/* 处理人工偏好盲评页面的选择与提交。 */

(() => {
  const study = JSON.parse(document.getElementById('study-data').textContent), storageKey = 'seatraces-review-' + study.protocolId;
  const $ = id => document.getElementById(id), random = n => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const shuffle = values => { const a = [...values]; for (let i = a.length - 1; i > 0; i--) { const j = random(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let state; try { state = JSON.parse(localStorage.getItem(storageKey)); } catch {}
  function validState(s) {
    if (!s || s.protocolId !== study.protocolId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s.reviewerId || '')
      || !Array.isArray(s.order) || s.order.length !== study.tasks.length || new Set(s.order).size !== study.tasks.length
      || !s.optionOrders || !s.responses || !Number.isInteger(s.index) || s.index < 0 || s.index > study.tasks.length) return false;
    for (const id of s.order) {
      const task = study.tasks.find(t => t.id === id), order = s.optionOrders[id], response = s.responses[id];
      if (!task || !Array.isArray(order) || order.length !== 2 || new Set(order).size !== 2 || order.some(key => !task.options.some(p => p.key === key))) return false;
      if (response && (response.taskId !== id || !['first','second','both','neither','unsure'].includes(response.choice)
        || JSON.stringify(response.order) !== JSON.stringify(order) || !Number.isFinite(response.elapsedMs) || response.elapsedMs < 0 || response.elapsedMs > 86400000)) return false;
    }
    return s.order.slice(0,s.index).every(id => s.responses[id]);
  }
  if (!validState(state)) {
    if (state) $('status').textContent = '本机旧进度不完整，已重新开始本轮评审。';
    state = { protocolId: study.protocolId, reviewerId: crypto.randomUUID(), order: [...shuffle(study.tasks.slice(0, study.primaryCount).map(t => t.id)), ...shuffle(study.tasks.slice(study.primaryCount).map(t => t.id))], optionOrders: {}, responses: {}, index: 0 };
    for (const task of study.tasks) state.optionOrders[task.id] = shuffle(task.options.map(p => p.key));
  }
  let shownAt = performance.now();
  function save() { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { $('status').textContent = '浏览器无法暂存进度，请保持页面打开，完成后下载答案。'; } }
  function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
  function finish() { $('review').hidden = true; $('done').hidden = false; save(); }
  function show() {
    $('intro').hidden = true; $('done').hidden = true; $('review').hidden = false;
    if (state.index >= study.tasks.length) return finish();
    const task = study.tasks.find(t => t.id === state.order[state.index]);
    if (!task) { $('status').textContent = '本机进度不匹配，请联系测试负责人。'; return; }
    shownAt = performance.now(); $('count').textContent = `${state.index + 1} / ${study.tasks.length}`; $('bar').style.width = `${100 * state.index / study.tasks.length}%`;
    $('scenario').textContent = task.scenario; $('cards').replaceChildren();
    for (const [i, key] of state.optionOrders[task.id].entries()) {
      const p = task.options.find(x => x.key === key), card = element('article');
      card.append(element('strong', i === 0 ? '第一篇' : '第二篇'), element('h2', p.title));
      const tags = element('div'); for (const t of p.tags) tags.append(element('span', t, 'tag')); card.append(tags);
      if (p.route) card.append(element('p', p.route, 'route'));
      card.append(element('div', p.body, 'body')); $('cards').append(card);
    }
    $('choices').replaceChildren();
    for (const [choice, label] of [['first','第一篇更合适'],['second','第二篇更合适'],['both','两篇都合适'],['neither','两篇都不合适'],['unsure','信息不足']]) {
      const btn = element('button', label); btn.type = 'button'; btn.classList.toggle('active', state.responses[task.id]?.choice === choice); btn.setAttribute('aria-pressed', String(state.responses[task.id]?.choice === choice));
      btn.onclick = () => { state.responses[task.id] = { taskId: task.id, order: state.optionOrders[task.id], choice, elapsedMs: Math.min(86400000, (state.responses[task.id]?.elapsedMs || 0) + Math.max(0, performance.now() - shownAt)) }; shownAt = performance.now(); save(); for (const b of $('choices').children) { b.classList.toggle('active', b === btn); b.setAttribute('aria-pressed', String(b === btn)); } $('next').disabled = false; };
      $('choices').append(btn);
    }
    $('back').disabled = state.index === 0; $('next').disabled = !state.responses[task.id]; $('next').textContent = state.index === study.tasks.length - 1 ? '完成评审' : '下一题'; save();
  }
  const answers = () => ({ protocolId: study.protocolId, reviewerId: state.reviewerId, responses: study.tasks.map(t => state.responses[t.id]) });
  $('start').onclick = show; $('back').onclick = () => { state.index--; show(); }; $('next').onclick = () => { state.index++; show(); window.scrollTo({top:0,behavior:'smooth'}); }; $('revise').onclick = () => { state.index = 0; show(); };
  $('download').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(answers(), null, 2)], {type:'application/json'})); const a = document.createElement('a'); a.href = url; a.download = 'seatraces-review-' + state.reviewerId + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  $('submit').onclick = async () => {
    if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1') { $('status').textContent = '请点击“下载答案文件”，把文件交给测试负责人。'; return; }
    $('submit').disabled = true;
    try { const r = await fetch('/answers', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(answers())}); const data = await r.json(); if (!r.ok) throw Error(data.error || '保存失败'); $('status').textContent = '已保存到本机实验目录，可关闭页面。'; }
    catch (e) { $('status').textContent = '未保存成功，请下载答案文件。'; } finally { $('submit').disabled = false; }
  };
})();
