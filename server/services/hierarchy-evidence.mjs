/* 收集景区层级资料，整理证据和评估任务。 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { hashJSON } from '../domain/scenic-hierarchy.mjs';

export async function atomicJSON(path, value) {
  await mkdir(new URL('./', path), {recursive: true});
  const tmp = new URL(path.href + '.tmp');
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}
export async function readJSON(path) {
  try {return JSON.parse(await readFile(path, 'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return null; throw error;}
}
export function plainText(html) {
  return html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[^]*?-->/g, ' ').replace(/<[^>]+>/g, '\n')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(0x10ffff, parseInt(n, 16))))
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(Math.min(0x10ffff, Number(n))))
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

export async function collectEvidence(registry, directory, {fetchImpl = fetch, now = Date.now()} = {}) {
  const evidence = [], errors = [];
  for (const entry of registry.sources) {
    const url = new URL(entry.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !registry.officialHosts.includes(url.hostname)) throw Error('unreviewed_source_url');
    const cachePath = new URL(hashJSON(entry.url) + '.json', directory);
    let saved = await readJSON(cachePath);
    const fresh = saved && now - Date.parse(saved.retrievedAt) >= 0 && now - Date.parse(saved.retrievedAt) < 86400_000;
    if (!fresh) {
      try {
        const response = await fetchImpl(url, {redirect: 'error', signal: AbortSignal.timeout(12000), headers: {'User-Agent': 'SeaTraces-evidence/1.0'}});
        if (!response.ok || !/text\/(html|plain)/i.test(response.headers.get('content-type') || '')) throw Error('page_unavailable');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        while (true) {
          const {done, value} = await reader.read(); if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024) {await reader.cancel(); throw Error('page_too_large');}
          chunks.push(value);
        }
        const bytes = Buffer.concat(chunks);
        const header = response.headers.get('content-type') || '';
        const encoding = /gb2312|gbk|gb18030/i.test(header + bytes.subarray(0, 2000).toString()) ? 'gb18030' : 'utf-8';
        const text = plainText(new TextDecoder(encoding).decode(bytes));
        if (text.length < 80 || /验证码|人机验证/.test(text.slice(0, 200))) throw Error('page_not_evidence');
        saved = {url: entry.url, text, sha256: createHash('sha256').update(bytes).digest('hex'), retrievedAt: new Date(now).toISOString(), publishedAt: null};
        await atomicJSON(cachePath, saved);
      } catch {
        errors.push({url: entry.url, status: 'fetch_failed'}); continue;
      }
    }
    evidence.push({...saved, id: hashJSON(entry.url).slice(0, 20), publisher: entry.publisher,
      parentNames: entry.parentNames, trust: 'official_registry', scope: entry.scope,
      fields: entry.fields || ['relation']});
  }
  return {evidence, errors};
}

export function buildEvidenceJobs(data, checks, evidence) {
  const byId = new Map(data.points.map(p => [p.id, p])), groups = new Map();
  for (const row of data.results) {
    if (row.status === 'child' || ['root', 'child'].includes(checks.get(row.placeId)?.status)) continue;
    for (const candidate of row.candidates) {
      if (candidate.boundaryTouch) continue;
      const parent = byId.get(candidate.parentId);
      if (!parent) continue;
      const matching = evidence.filter(e => e.parentNames.some(n => [parent.name, ...(parent.aliases || [])].includes(n)));
      const child = byId.get(row.placeId);
      const mentions = matching.filter(e => [child.name, ...(child.aliases || [])].some(n => n.length >= 2 && e.text.includes(n)));
      if (!mentions.length) continue;
      if (!groups.has(parent.id)) groups.set(parent.id, {parent, children: new Map(), sources: new Map()});
      const group = groups.get(parent.id);
      group.children.set(child.id, child);
      for (const source of mentions) group.sources.set(source.id, source);
    }
  }
  const brief = p => ({id: p.id, name: p.name, aliases: p.aliases || [], lat: p.lat, lng: p.lng});
  const jobs = [];
  for (const group of [...groups.values()].sort((a,b) => a.parent.id.localeCompare(b.parent.id))) {
    const all = [...group.children.values()].sort((a,b) => a.id.localeCompare(b.id));
    for (let offset = 0; offset < all.length; offset += 8) {
      const children = all.slice(offset, offset+8), snippets = [];
      for (const source of group.sources.values()) {
        const intervals = [];
        for (const child of children) {
          let index = source.text.indexOf(child.name);
          if (index < 0) index = (child.aliases || []).map(n => source.text.indexOf(n)).find(i => i >= 0) ?? -1;
          if (index >= 0) intervals.push([Math.max(0,index-200), Math.min(source.text.length,index+750)]);
        }
        intervals.sort((a,b) => a[0]-b[0]);
        const merged = [];
        for (const span of intervals) {
          const last = merged.at(-1);
          if (last && span[0] <= last[1]) last[1] = Math.max(last[1],span[1]); else merged.push([...span]);
        }
        for (const [start,end] of merged) snippets.push({...source, id: source.id + '-' + start, text: source.text.slice(start,end)});
      }
      if (snippets.length) jobs.push({parent: brief(group.parent), children: children.map(brief),
        evidence: snippets.slice(0,16).map(e => ({...e, text:e.text.slice(0,3000)}))});
    }
  }
  return jobs;
}
