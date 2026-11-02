// ==UserScript==
// @name         JavArr - JAV scene to Prowlarr search
// @namespace    https://github.com/gurgles-1
// @version      2.0.0
// @description  JavStash: auto-grab by exact code match + listing-page batch mode. StashDB: scored manual search (western naming). Sends grabs to Prowlarr.
// @author       Muse for Evan
// @match        https://javstash.org/*
// @match        https://stashdb.org/scenes/*
// @downloadURL  https://raw.githubusercontent.com/gurgles-1/javarr/main/javarr.user.js
// @updateURL    https://raw.githubusercontent.com/gurgles-1/javarr/main/javarr.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @license      MIT
// ==/UserScript==

(function() {
'use strict';

/* ---------------- settings ---------------- */
const CFG = {
  get prowlarrUrl()  { return GM_getValue('prowlarrUrl', ''); },
  get prowlarrKey()  { return GM_getValue('prowlarrKey', ''); },
  get categories()   { return GM_getValue('categories', '6000'); }, // 6000 = XXX
  get resultLimit()  { return GM_getValue('resultLimit', '100'); },
  get minSizeMB()    { return Number(GM_getValue('minSizeMB', '100')) || 0; },
  get batchLimit()   { return Number(GM_getValue('batchLimit', '60')) || 60; },
  get batchDelayMs() { return Number(GM_getValue('batchDelayMs', '350')) || 350; },
};

GM_registerMenuCommand('JavArr: Configure Prowlarr', () => {
  const url = prompt('Prowlarr URL (no trailing slash):', CFG.prowlarrUrl || 'http://192.168.68.64:9696');
  if (url === null) return;
  const key = prompt('Prowlarr API key:', CFG.prowlarrKey);
  if (key === null) return;
  GM_setValue('prowlarrUrl', url.replace(/\/$/, ''));
  GM_setValue('prowlarrKey', key);
  alert('JavArr: Prowlarr configured.');
});

GM_registerMenuCommand('JavArr: Configure automation', () => {
  const mb = prompt('Minimum release size for auto-grab, MB (0 = no floor):', String(CFG.minSizeMB));
  if (mb === null) return;
  const lim = prompt('Batch mode: max scenes per run:', String(CFG.batchLimit));
  if (lim === null) return;
  GM_setValue('minSizeMB', mb);
  GM_setValue('batchLimit', lim);
  alert('JavArr: automation settings saved.');
});

/* ---------------- helpers ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const sleep = ms => new Promise(res => setTimeout(res, ms));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const cleanTitle = t => String(t || '').replace(/[([{][^)\]}]*[)\]}]/g, ' ')
  .replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();

function resolutionOf(title) {
  const h = title || '';
  if (/\b(2160p|4k|uhd)\b/i.test(h)) return '2160p';
  if (/\b1080p\b/i.test(h)) return '1080p';
  if (/\b720p\b/i.test(h)) return '720p';
  const m = h.match(/\b(\d{3,4})p\b/i);
  return m ? m[1].toLowerCase() + 'p' : 'other';
}
const RES_RANK = { '2160p': 0, '1080p': 1, '720p': 2, 'other': 3 };
const resRank = t => RES_RANK[resolutionOf(t)] ?? 3;
const popOf = r => (r.seeders != null ? r.seeders : (r.grabs != null ? r.grabs : 0));

function fmtSize(b) {
  if (!b) return '';
  const u = ['B','KB','MB','GB']; let i = 0;
  while (b >= 1024 && i < 3) { b /= 1024; i++; }
  return b.toFixed(1) + ' ' + u[i];
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function gmFetch(url, opts) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest(Object.assign({ url, onload: resolve, onerror: reject }, opts));
  });
}

/* ---------------- JAV code handling ---------------- */
// CODE_UTILS_START
function parseCode(raw) {
  // "SSIS-001" / "ssis001" / "ABC-12" -> { prefix, num } ; null if not code-shaped.
  // Date-style codes (1pondo / Caribbeancom, e.g. 010126-001) intentionally do not parse.
  const m = String(raw || '').trim().toUpperCase().match(/^([A-Z]{2,8})[-_ ]?(\d{1,5})$/);
  if (!m) return null;
  return { prefix: m[1], num: parseInt(m[2], 10), digits: m[2].length };
}

function codeQueries(raw) {
  // Search forms, most canonical first: SSIS-001, SSIS001, SSIS-1, SSIS1
  const p = parseCode(raw);
  if (!p) return [String(raw || '').trim()].filter(Boolean);
  const padded = String(p.num).padStart(Math.max(3, p.digits), '0');
  return [...new Set([
    `${p.prefix}-${padded}`,
    `${p.prefix}${padded}`,
    `${p.prefix}-${p.num}`,
    `${p.prefix}${p.num}`,
  ])];
}

function releaseMatchesCode(title, rawCode) {
  const p = parseCode(rawCode);
  const hay = String(title || '').toUpperCase();
  if (!p) {
    // Unparseable code: fall back to normalized literal containment.
    const needle = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
    return needle.length >= 4 && hay.replace(/[^A-Z0-9]+/g, '').includes(needle);
  }
  const tokens = hay.match(/[A-Z]{2,8}[-_ ]?\d{1,5}/g) || [];
  for (const t of tokens) {
    const tp = parseCode(t);
    if (tp && tp.prefix === p.prefix && tp.num === p.num) return true;
  }
  return false;
}
// CODE_UTILS_END

/* ---------------- scene metadata (stash-box GraphQL) ---------------- */
function sceneIdFromUrl() {
  const m = location.pathname.match(/\/scenes\/([a-f0-9-]{36})/i);
  return m ? m[1] : null;
}

async function fetchSceneMeta(id) {
  const sid = id || sceneIdFromUrl();
  if (!sid) return null;
  const gql = `query { findScene(id: "${sid}") {
    id title code date
    studio { name }
    performers { performer { name } as }
    tags { tag { name } }
  } }`;
  const resp = await gmFetch(location.origin + '/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql }),
  });
  const data = JSON.parse(resp.responseText);
  return data?.data?.findScene || null;
}

/* ---------------- prowlarr ---------------- */
async function prowlarrSearch(query) {
  const base = CFG.prowlarrUrl, key = CFG.prowlarrKey;
  if (!base || !key) throw new Error('Configure Prowlarr first (Violentmonkey menu).');
  const params = new URLSearchParams({
    apikey: key, query, categories: CFG.categories, limit: CFG.resultLimit, type: 'search',
  });
  const resp = await gmFetch(`${base}/api/v1/search?${params}`, { method: 'GET' });
  if (resp.status !== 200) throw new Error(`Prowlarr search HTTP ${resp.status}`);
  return JSON.parse(resp.responseText);
}

async function prowlarrGrab(guid, indexerId) {
  const base = CFG.prowlarrUrl, key = CFG.prowlarrKey;
  if (!base || !key) throw new Error('Configure Prowlarr first (Violentmonkey menu).');
  const params = new URLSearchParams({ apikey: key });
  const resp = await gmFetch(`${base}/api/v1/search?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guid, indexerId }),
  });
  if (resp.status < 200 || resp.status >= 300) throw new Error(`Grab HTTP ${resp.status}`);
}

/* ---------------- release scoring (western / StashDB flow, kept from v1) ---------------- */
function scoreRelease(title, meta) {
  const hay = norm(title);
  let score = 0; const hits = [];
  const studio = meta?.studio?.name || '';
  if (studio && hay.includes(norm(studio))) { score++; hits.push('Studio'); }
  const performers = (meta?.performers || []).map(p => p.performer?.name || p.as).filter(Boolean);
  let pHits = 0;
  for (const p of performers) {
    if (p && hay.includes(norm(p))) pHits++;
  }
  if (pHits > 0) { score++; hits.push(`Performer ${pHits}/${performers.length}`); }
  const t = cleanTitle(meta?.title || '');
  const words = t.split(' ').filter(w => w.length > 3);
  const matched = words.filter(w => hay.includes(norm(w))).length;
  if (words.length && matched / words.length >= 0.6) { score++; hits.push('Title'); }
  const date = (meta?.date || '').slice(0, 10);
  if (date && (title.includes(date) || title.includes(date.slice(2).replace(/-/g, '.')))) { score++; hits.push('Date'); }
  const code = meta?.code || '';
  if (code && hay.includes(norm(code))) { score++; hits.push('Code'); }
  return { score, hits };
}

function buildQueries(meta) {
  const studio = meta?.studio?.name || '';
  const performers = (meta?.performers || []).map(p => p.performer?.name || p.as).filter(Boolean);
  const date = (meta?.date || '').slice(0, 10);
  const code = meta?.code || '';
  const title = cleanTitle(meta?.title || '');
  const q = [];
  if (code) q.push(code);                                    // most precise
  if (performers.length && studio) q.push(`${performers.join(' ')} ${studio}`);
  if (performers.length && date) q.push(`${performers.join(' ')} ${date}`);
  if (title) q.push(title);
  if (performers.length) q.push(performers.join(' '));
  return [...new Set(q)].slice(0, 5);
}

/* ---------------- code-first search + pick (JavStash flow) ---------------- */
async function searchByCode(rawCode) {
  const forms = codeQueries(rawCode);
  const all = []; const seen = new Set();
  for (const q of forms) {
    try {
      const results = await prowlarrSearch(q);
      for (const r of results) {
        const key = r.guid || (r.indexer + '|' + r.title);
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(r);
      }
    } catch (e) { console.warn('JavArr query failed:', q, e); }
    if (all.some(r => releaseMatchesCode(r.title || r.sortTitle, rawCode))) break; // exact found; stop widening
  }
  return all;
}

function pickBest(releases, rawCode) {
  const floor = CFG.minSizeMB * 1024 * 1024;
  const exact = releases.filter(r => releaseMatchesCode(r.title || r.sortTitle, rawCode));
  let pool = exact.filter(r => !floor || (r.size || 0) >= floor);
  let floorDropped = false;
  if (!pool.length && exact.length) { pool = exact; floorDropped = true; }
  pool.sort((a, b) =>
    (resRank(a.title) - resRank(b.title)) ||
    (popOf(b) - popOf(a)) ||
    ((b.size || 0) - (a.size || 0)));
  return { best: pool[0] || null, exact, floorDropped };
}

/* ---------------- panel UI ---------------- */
function injectStyles() {
  if ($('#javarr-styles')) return;
  const css = `
  .javarr-btn { position: fixed; bottom: 24px; right: 24px; z-index: 99999;
    background: #e91e63; color: #fff; border: none; border-radius: 8px;
    padding: 12px 20px; font-size: 14px; font-weight: 700; cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,.4); }
  .javarr-btn:hover { background: #c2185b; }
  .javarr-btn:disabled { background: #666; cursor: wait; }
  #javarr-batch-btn { bottom: 76px; background: #6a1b9a; }
  #javarr-batch-btn:hover { background: #4a148c; }
  #javarr-panel { position: fixed; bottom: 128px; right: 24px; z-index: 99999;
    width: 560px; max-height: 70vh; overflow-y: auto; background: #1e1e1e;
    color: #eee; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.6);
    font-size: 13px; display: none; }
  #javarr-panel.open { display: block; }
  #javarr-panel header { padding: 12px 16px; font-weight: 700; border-bottom: 1px solid #333;
    display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0;
    background: #1e1e1e; z-index: 2; }
  #javarr-panel .q { padding: 8px 16px; color: #888; font-size: 12px; border-bottom: 1px solid #2a2a2a; }
  .javarr-res { padding: 10px 16px; border-bottom: 1px solid #2a2a2a; }
  .javarr-res .t { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
  .javarr-res .m { color: #999; font-size: 12px; margin-bottom: 6px; }
  .javarr-res .score { color: #4caf50; font-weight: 700; }
  .javarr-dl { background: #2196f3; color: #fff; border: none; border-radius: 4px;
    padding: 6px 12px; cursor: pointer; font-size: 12px; }
  .javarr-dl:hover { background: #1976d2; }
  .javarr-dl.sent { background: #4caf50; }
  .javarr-group { padding: 6px 16px; background: #2a2a2a; font-weight: 700; color: #bbb;
    position: sticky; top: 41px; }
  .javarr-row { padding: 7px 16px; border-bottom: 1px solid #2a2a2a; font-size: 12px;
    display: flex; gap: 8px; align-items: baseline; }
  .javarr-row .code { font-weight: 700; min-width: 92px; color: #fff; }
  .javarr-row .st-grabbed { color: #4caf50; font-weight: 700; }
  .javarr-row .st-manual { color: #ffb300; font-weight: 700; }
  .javarr-row .st-miss { color: #ef5350; font-weight: 700; }
  .javarr-row .st-nocode, .javarr-row .st-error { color: #999; font-weight: 700; }
  .javarr-row .detail { color: #aaa; word-break: break-all; }
  #javarr-stop { background: #b71c1c; color: #fff; border: none; border-radius: 4px;
    padding: 6px 12px; cursor: pointer; font-size: 12px; }
  `;
  const st = document.createElement('style');
  st.id = 'javarr-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function getPanel() {
  let panel = $('#javarr-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'javarr-panel';
    document.body.appendChild(panel);
  }
  return panel;
}

function wireGrabButtons(panel) {
  $$('.javarr-dl', panel).forEach(b => {
    b.onclick = async () => {
      b.textContent = 'Sending...'; b.disabled = true;
      try {
        await prowlarrGrab(b.dataset.guid, Number(b.dataset.idx));
        b.textContent = '✓ Sent'; b.classList.add('sent');
      } catch (e) {
        b.textContent = 'Failed'; b.disabled = false;
      }
    };
  });
}

function releaseRow(r, extra) {
  const size = fmtSize(r.size);
  const pop = r.seeders != null ? `${r.seeders} seeders` : (r.grabs != null ? `${r.grabs} grabs` : '');
  return `<div class="javarr-res">
    <div class="t">${escapeHtml(r.title)}</div>
    <div class="m">${extra || ''} · ${escapeHtml(r.indexer || '')} · ${size} · ${pop}</div>
    <button class="javarr-dl" data-guid="${escapeHtml(r.guid)}" data-idx="${r.indexerId}">Download</button>
  </div>`;
}

/* ---------------- JavStash: scene page auto-grab ---------------- */
async function onJavSceneClick(btn) {
  btn.textContent = 'Loading scene...'; btn.disabled = true;
  try {
    const meta = await fetchSceneMeta();
    if (!meta) throw new Error('Could not read scene metadata. Are you logged in?');
    if (!meta.code) throw new Error('Scene has no code on JavStash; auto-grab needs one.');
    btn.textContent = `Searching ${meta.code}...`;
    const all = await searchByCode(meta.code);
    const { best, exact, floorDropped } = pickBest(all, meta.code);
    const panel = getPanel();
    const code = escapeHtml(meta.code);
    let html = `<header><span>${code} — ${escapeHtml(meta.title || '')}</span>
      <button id="javarr-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px">✕</button></header>`;
    if (best) {
      btn.textContent = 'Grabbing...';
      try {
        await prowlarrGrab(best.guid, best.indexerId);
        html += `<div class="javarr-res"><div class="t" style="color:#4caf50">✓ AUTO-GRABBED</div>
          <div class="m">${escapeHtml(best.title)} · ${escapeHtml(best.indexer || '')} · ${fmtSize(best.size)}</div>
          ${floorDropped ? '<div class="m">Note: all exact matches were under the size floor; grabbed the best anyway.</div>' : ''}
        </div>`;
      } catch (e) {
        html += `<div class="javarr-res"><div class="t" style="color:#ef5350">Grab failed: ${escapeHtml(e.message)}</div></div>`;
      }
      const others = exact.filter(r => r !== best);
      if (others.length) {
        html += `<div class="javarr-group">Other exact-code matches (${others.length})</div>`;
        others.sort((a, b) => (resRank(a.title) - resRank(b.title)) || (popOf(b) - popOf(a)));
        for (const r of others) html += releaseRow(r, `<span class="score">EXACT</span> ${resolutionOf(r.title)}`);
      }
    } else if (all.length) {
      html += `<div class="q">No exact code match. ${all.length} near results — pick manually:</div>`;
      const scored = all.map(r => Object.assign({}, r, scoreRelease(r.title || r.sortTitle, meta)))
        .sort((a, b) => (b.score - a.score) || (resRank(a.title) - resRank(b.title)));
      for (const r of scored) html += releaseRow(r, `<span class="score">${r.score}/5 (${r.hits.join(', ') || 'no hits'})</span>`);
    } else {
      html += `<div class="javarr-res">No results for ${code} in any form. Nothing to grab.</div>`;
    }
    panel.innerHTML = html;
    panel.classList.add('open');
    $('#javarr-close').onclick = () => panel.classList.remove('open');
    wireGrabButtons(panel);
    btn.textContent = '⬇ Auto-Grab (Code)'; btn.disabled = false;
  } catch (e) {
    btn.textContent = 'Error: ' + e.message; btn.disabled = false;
    setTimeout(() => { btn.textContent = '⬇ Auto-Grab (Code)'; }, 4000);
  }
}

/* ---------------- StashDB: scene page manual search (v1 flow) ---------------- */
async function onStashSceneClick(btn) {
  btn.textContent = 'Loading scene...'; btn.disabled = true;
  try {
    const meta = await fetchSceneMeta();
    if (!meta) throw new Error('Could not read scene metadata. Are you logged in?');
    btn.textContent = 'Searching Prowlarr...';
    const queries = buildQueries(meta);
    const all = [];
    const seen = new Set();
    for (const q of queries) {
      try {
        const results = await prowlarrSearch(q);
        for (const r of results) {
          const key = r.guid || (r.indexer + '|' + r.title);
          if (seen.has(key)) continue;
          seen.add(key);
          const { score, hits } = scoreRelease(r.title || r.sortTitle, meta);
          all.push(Object.assign({}, r, { score, hits, query: q }));
        }
      } catch (e) { console.warn('JavArr query failed:', q, e); }
    }
    let filtered = all.filter(r => r.score >= 2);
    if (!filtered.length) filtered = all;
    filtered.sort((a, b) =>
      (resRank(a.title) - resRank(b.title)) ||
      (b.score - a.score) || (popOf(b) - popOf(a)));
    const panel = getPanel();
    const code = meta.code ? ` [${meta.code}]` : '';
    let html = `<header><span>${escapeHtml(meta.title || '')}${escapeHtml(code)}</span>
      <button id="javarr-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px">✕</button></header>`;
    html += `<div class="q">Queries: ${queries.map(escapeHtml).join(' · ')}</div>`;
    if (!filtered.length) {
      html += `<div class="javarr-res">No results. Try widening the search.</div>`;
    } else {
      let lastRes = '';
      for (const r of filtered) {
        const res = resolutionOf(r.title);
        if (res !== lastRes) { html += `<div class="javarr-group">${res}</div>`; lastRes = res; }
        html += releaseRow(r, `<span class="score">${r.score}/5 (${r.hits.join(', ') || 'no hits'})</span>`);
      }
    }
    panel.innerHTML = html;
    panel.classList.add('open');
    $('#javarr-close').onclick = () => panel.classList.remove('open');
    wireGrabButtons(panel);
    btn.textContent = '⬇ Search Prowlarr'; btn.disabled = false;
  } catch (e) {
    btn.textContent = 'Error: ' + e.message; btn.disabled = false;
    setTimeout(() => { btn.textContent = '⬇ Search Prowlarr'; }, 4000);
  }
}

/* ---------------- JavStash: listing-page batch mode ---------------- */
let batchState = { running: false, stop: false };

function harvestSceneIds() {
  const ids = [];
  const seen = new Set();
  for (const a of $$('a[href*="/scenes/"]')) {
    const m = (a.getAttribute('href') || '').match(/\/scenes\/([a-f0-9-]{36})/i);
    if (m && !seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
  }
  return ids;
}

async function onBatchClick(btn) {
  if (batchState.running) return;
  const ids = harvestSceneIds().slice(0, CFG.batchLimit);
  if (!ids.length) { btn.textContent = 'No scene links on this page'; setTimeout(() => refreshButtons(), 2500); return; }
  batchState = { running: true, stop: false };
  btn.disabled = true;
  const panel = getPanel();
  panel.innerHTML = `<header><span id="javarr-batch-title">Batch: 0/${ids.length}</span>
    <span><button id="javarr-stop">Stop</button>
    <button id="javarr-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px">✕</button></span></header>
    <div id="javarr-batch-rows"></div>
    <div class="q" id="javarr-batch-summary">Running...</div>`;
  panel.classList.add('open');
  $('#javarr-close').onclick = () => panel.classList.remove('open');
  $('#javarr-stop').onclick = () => { batchState.stop = true; };
  const rowsEl = $('#javarr-batch-rows');
  const tally = { grabbed: 0, manual: 0, miss: 0, nocode: 0, error: 0 };
  const missCodes = [];
  for (let i = 0; i < ids.length; i++) {
    if (batchState.stop) break;
    const title = $('#javarr-batch-title');
    if (title) title.textContent = `Batch: ${i + 1}/${ids.length}`;
    const row = document.createElement('div');
    row.className = 'javarr-row';
    row.innerHTML = `<span class="code">...</span><span class="detail">working</span>`;
    rowsEl.appendChild(row);
    const setRow = (code, stClass, stText, detail) => {
      row.innerHTML = `<span class="code">${escapeHtml(code || '?')}</span>` +
        `<span class="${stClass}">${stText}</span><span class="detail">${escapeHtml(detail || '')}</span>`;
    };
    try {
      const meta = await fetchSceneMeta(ids[i]);
      if (!meta || !meta.code) { tally.nocode++; setRow(meta?.code, 'st-nocode', 'NO CODE', meta ? (meta.title || '') : 'metadata fetch failed'); }
      else {
        const all = await searchByCode(meta.code);
        const { best, exact } = pickBest(all, meta.code);
        if (best) {
          await prowlarrGrab(best.guid, best.indexerId);
          tally.grabbed++;
          setRow(meta.code, 'st-grabbed', 'GRABBED', `${best.title} (${fmtSize(best.size)})`);
        } else if (all.length) {
          tally.manual++;
          setRow(meta.code, 'st-manual', `MANUAL (${all.length})`, exact.length ? 'exact matches under size floor only' : 'results exist, none exact-code');
        } else {
          tally.miss++; missCodes.push(meta.code);
          setRow(meta.code, 'st-miss', 'MISS', 'no results in any code form');
        }
      }
    } catch (e) {
      tally.error++;
      setRow(null, 'st-error', 'ERROR', e.message);
    }
    if (i < ids.length - 1 && !batchState.stop) await sleep(CFG.batchDelayMs);
  }
  const summary = $('#javarr-batch-summary');
  if (summary) {
    summary.textContent =
      `Done${batchState.stop ? ' (stopped)' : ''}: ${tally.grabbed} grabbed · ${tally.manual} manual-check · ` +
      `${tally.miss} misses · ${tally.nocode} no-code · ${tally.error} errors` +
      (missCodes.length ? ` | Misses: ${missCodes.join(', ')}` : '');
  }
  batchState.running = false;
  btn.disabled = false;
  refreshButtons();
}

/* ---------------- button management (SPA-aware) ---------------- */
const isJavStash = () => location.hostname === 'javstash.org';
const isScenePage = () => !!sceneIdFromUrl();

function makeButton(id, label, onClick) {
  const btn = document.createElement('button');
  btn.id = id;
  btn.className = 'javarr-btn';
  btn.textContent = label;
  btn.onclick = () => onClick(btn);
  document.body.appendChild(btn);
  return btn;
}

function refreshButtons() {
  injectStyles();
  const sceneBtn = $('#javarr-btn');
  const batchBtn = $('#javarr-batch-btn');
  if (isScenePage()) {
    if (batchBtn) batchBtn.remove();
    if (!sceneBtn) {
      if (!CFG.prowlarrUrl || !CFG.prowlarrKey) {
        const b = makeButton('javarr-btn', '⚙ Configure JavArr', () => {
          alert('Open the Violentmonkey menu (extension icon) → "JavArr: Configure Prowlarr" to set your Prowlarr URL and API key.');
        });
        b.id = 'javarr-btn';
      } else if (isJavStash()) {
        makeButton('javarr-btn', '⬇ Auto-Grab (Code)', onJavSceneClick);
      } else {
        makeButton('javarr-btn', '⬇ Search Prowlarr', onStashSceneClick);
      }
    }
  } else if (isJavStash()) {
    if (sceneBtn) sceneBtn.remove();
    const n = Math.min(harvestSceneIds().length, CFG.batchLimit);
    if (n > 0) {
      if (!batchBtn) makeButton('javarr-batch-btn', '', onBatchClick).textContent = `⬇ Batch Grab (${n})`;
      else if (!batchState.running) batchBtn.textContent = `⬇ Batch Grab (${n})`;
    } else if (batchBtn && !batchState.running) {
      batchBtn.remove();
    }
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refreshButtons(); }, 700);
}

function init() {
  refreshButtons();
  // JavStash is a React SPA: routes and grids render without page loads.
  new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true });
}

init();
})();
