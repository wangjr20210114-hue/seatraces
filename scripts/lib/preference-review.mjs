// Human evidence is diagnostic, never an automatic model-activation signal.
import { createHash } from 'node:crypto';
export const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
export const choices = ['first', 'second', 'both', 'neither', 'unsure'];
export function disagreement(a, b, used = new Set()) {
  const ra = new Map(a.map((p, i) => [p.id, i])), rb = new Map(b.map((p, i) => [p.id, i]));
  for (const p of a.slice(0, 30)) for (const q of b.slice(0, 30)) {
    const pair = [p.id, q.id].sort().join(':');
    if (p.id !== q.id && !used.has(pair) && ra.get(p.id) < ra.get(q.id) && rb.get(q.id) < rb.get(p.id)
      && p.score > a[ra.get(q.id)].score + 1e-9 && q.score > b[rb.get(p.id)].score + 1e-9) return { pair, ids: [p.id, q.id] };
  }
  return null;
}
export function validateAnswers(study, input) {
  if (!input || input.protocolId !== study.protocolId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.reviewerId || '') || !Array.isArray(input.responses)
    || input.responses.length !== study.tasks.length) throw Error('Study identity or answer count is invalid');
  const byId = new Map(study.tasks.map(t => [t.id, t])), seen = new Set();
  for (const r of input.responses) {
    if (!r || typeof r !== 'object') throw Error('Invalid answer');
    const task = byId.get(r.taskId);
    if (!task || seen.has(r.taskId) || !choices.includes(r.choice) || !Array.isArray(r.order) || r.order.length !== 2
      || new Set(r.order).size !== 2 || r.order.some(id => !task.options.some(p => p.key === id))
      || !Number.isFinite(r.elapsedMs) || r.elapsedMs < 0 || r.elapsedMs > 86400000) throw Error('Invalid answer');
    seen.add(r.taskId);
  }
  return { protocolId: input.protocolId, reviewerId: input.reviewerId, responses: input.responses.map(r => ({ taskId: r.taskId, order: [...r.order], choice: r.choice, elapsedMs: r.elapsedMs })) };
}
export function summarizeReview(study, privateProtocol, answers) {
  if (privateProtocol.protocolId !== study.protocolId || privateProtocol.probes.length !== study.tasks.length
    || new Set(privateProtocol.probes.map(p => p.taskId)).size !== study.tasks.length) throw Error('Protocol mismatch');
  const valid = validateAnswers(study, answers), byId = new Map(valid.responses.map(r => [r.taskId, r])), totals = {};
  let repeatAgreements = 0, repeats = 0;
  const selected = r => ['first', 'second'].includes(r.choice) ? r.order[r.choice === 'first' ? 0 : 1] : r.choice;
  for (const row of privateProtocol.probes) {
    const r = byId.get(row.taskId);
    if (!r || (row.repeatOf && !byId.has(row.repeatOf))) throw Error('Protocol task mismatch');
    if (row.repeatOf) { repeats++; if (selected(r) === selected(byId.get(row.repeatOf))) repeatAgreements++; continue; }
    const key = row.methods.join(' vs '), total = totals[key] ||= { firstMethodWins: 0, secondMethodWins: 0, both: 0, neither: 0, unsure: 0, tasks: 0 };
    total.tasks++;
    if (['first', 'second'].includes(r.choice)) total[selected(r) === row.preferredKeys[0] ? 'firstMethodWins' : 'secondMethodWins']++;
    else total[r.choice]++;
  }
  return { protocolId: study.protocolId, reviewerId: valid.reviewerId, totals, repeatAgreements, repeats,
    diagnosticOnly: true, activationAllowed: false, limitation: 'Scenario-conditioned judgments on selected synthetic-content disagreements; not a representative feed experiment, not mature real outcomes, not NDCG.' };
}
export function safeJSON(value) { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
export function renderReview(study, client) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SeaTraces · 帖子偏好盲评</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f4f7fa;color:#193d42;font:16px/1.65 system-ui,sans-serif}main{max-width:1050px;margin:auto;padding:28px 20px 70px}h1{font-size:26px;margin:0}h2{font-size:20px;margin:8px 0}button{font:inherit;cursor:pointer;border:1px solid #abc3c8;border-radius:12px;padding:10px 18px;background:#fff;color:inherit}button:hover{border-color:#148877}button:disabled{cursor:default;opacity:.5}button.active,.primary{background:#177e71;color:white;border-color:#177e71}.hint{color:#526a70;font-size:14px}.intro,.scenario,article{background:white;border:1px solid #dfe8eb;border-radius:18px;padding:20px;margin-top:18px}.scenario{border-left:5px solid #f1bc4a;background:#fffcec}.cards{display:grid;grid-template-columns:1fr 1fr;gap:16px}article{min-width:0}article .body{white-space:pre-wrap;overflow-wrap:anywhere}article .tag{display:inline-block;border-radius:8px;background:#e7f5ef;padding:2px 8px;margin:2px 5px 4px 0;font-size:13px}.route{font-size:14px;margin:10px 0;color:#526a70}.choicebar,.nav{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.nav{justify-content:space-between}.progress{height:7px;border-radius:8px;background:#dae7e7;overflow:hidden;margin:20px 0}.progress i{display:block;height:100%;background:#21ae94}#status{min-height:28px;overflow-wrap:anywhere}a{color:#147d70}[hidden]{display:none!important}@media(max-width:650px){main{padding:18px 12px 50px}.cards{grid-template-columns:1fr}button{padding:10px 12px}article{margin-top:10px}}</style>
<main><header><h1>SeaTraces · 帖子偏好盲评</h1><p class="hint">约 10 分钟 · 每题一个选择 · 请独立完成</p></header>
<section id="intro" class="intro"><h2>哪篇更适合这位旅行者？</h2><p>按每题给定的旅行偏好，选择更值得推荐的一篇。不是要求你扮演算法，也不需要猜标准答案。</p><p>内容来自项目现有模拟帖子，不是实际旅行评价。不显示作者、点赞量或算法分数。可选“两篇都合适”“两篇都不合适”或“信息不足”。少量重复题用于检查一致性。</p><p>答案仅保存在本机研究文件中，不写入正式用户画像，不会自动启用模型。刷新可继续；交给队友时，每人使用自己的浏览器独立完成。</p><button id="start" class="primary">开始 / 继续</button></section>
<section id="review" hidden><div class="progress"><i id="bar"></i></div><p id="count"></p><div class="scenario"><strong>旅行偏好</strong><p id="scenario"></p><span class="hint">未给出的预算、开放时间和实际路况，不自行假设。</span></div><div class="cards" id="cards"></div><div class="choicebar" id="choices"></div><div class="nav"><button id="back">上一题</button><button id="next" class="primary">下一题</button></div></section>
<section id="done" class="intro" hidden><h2>已完成，谢谢！</h2><p>请保存结果。为了避免影响队友的判断，这里不展示算法得分。</p><div class="choicebar"><button id="submit" class="primary">保存到本机实验目录</button><button id="download">下载答案文件</button><button id="revise">检查答案</button></div><p class="hint">若直接双击 HTML 打开，请下载答案文件；通过本机测试地址打开可直接保存。</p></section><p id="status" role="status" aria-live="polite"></p></main>
<script id="study-data" type="application/json">${safeJSON(study)}</script><script>${client}</script></html>`;
}
