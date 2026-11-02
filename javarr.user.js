// ==UserScript==
// @name         JavArr - JAV scene to Prowlarr search
// @namespace    https://github.com/gurgles-1
// @version      2.1.0
// @description  JavStash: auto-grab by exact code + listing batch mode. StashDB: staged escalating search with scored manual picks. Both: Prowlarr-history dedupe, skip list, Stash-owned badges. Sends grabs to Prowlarr.
// @author       Muse for Evan
// @match        https://javstash.org/*
// @match        https://stashdb.org/*
// @downloadURL  https://raw.githubusercontent.com/gurgles-1/javarr/main/javarr.user.js
// @updateURL    https://raw.githubusercontent.com/gurgles-1/javarr/main/javarr.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @license      MIT
// ==/UserScript==

/* Design notes: several behaviors in this version were adapted as IDEAS from
   two other StashDB tools — stasharr by enymawse (GPL-3.0: scene-status
   awareness, exclusion lists, bulk confirmation) and stasharr by brewing8309
   (PolyForm Noncommercial: three-stage escalating search, performer aliases
   and parent-studio queries, accent folding, Stash-owned card badges).
   No code was copied from either; this implementation is original, MIT. */

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
  get historySize()  { return Number(GM_getValue('historySize', '500')) || 500; },
  get stashUrl()     { return GM_getValue('stashUrl', ''); },
  get stashKey()     { return GM_getValue('stashKey', ''); },
  get skipCodes() {
    try { return JSON.parse(GM_getValue('skipCodes', '[]')); } catch (e) { return []; }
  },
  set skipCodes(v) { GM_setValue('skipCodes', JSON.stringify(v)); },
};
const prowlarrConfigured = () => !!(CFG.prowlarrUrl && CFG.prowlarrKey);
const stashConfigured = () => !!CFG.stashUrl;

GM_registerMenuCommand('JavArr: Configure Prowlarr', () => {
  const url = prompt('Prowlarr URL (no trailing slash):', CFG.prowlarrUrl || 'http://192.168.68.64:9696');
  if (url === null) return;
  const key = prompt('Prowlarr API key:', CFG.prowlarrKey);
  if (key === null) return;
  GM_setValue('prowlarrUrl', url.replace(/\/$/, ''));
  GM_setValue('prowlarrKey', key);
  alert('JavArr: Prowlarr configured.');
});

GM_registerMenuCommand('JavArr: Configure Stash (owned badges)', () => {
  const url = prompt('Stash URL (no trailing slash, blank = disable):', CFG.stashUrl || 'http://192.168.68.64:9999');
  if (url === null) return;
  const key = prompt('Stash API key (blank if Stash auth is off):', CFG.stashKey);
  if (key === null) return;
  GM_setValue('stashUrl', url.replace(/\/$/, ''));
  GM_setValue('stashKey', key);
  alert('JavArr: Stash configured.');
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

GM_registerMenuCommand('JavArr: Edit skip list', () => {
  const cur = CFG.skipCodes.join(', ');
  const v = prompt('Skip list — codes batch/auto-grab will never touch (comma-separated). Manual grabs from a scene page still work:', cur);
  if (v === null) return;
  CFG.skipCodes = [...new Set(v.split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
  alert(`JavArr: skip list saved (${CFG.skipCodes.length} codes).`);
});

/* ---------------- generic helpers ---------------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const sleep = ms => new Promise(res => setTimeout(res, ms));

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

/* ---------------- pure matching logic (unit-tested; see tests/) ---------------- */
// TESTABLE_START
function foldText(s) {
  // Accent folding: "Zoë" -> "zoe"; ß -> ss. Non-Latin scripts survive.
  return String(s || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/ß/g, 'ss');
}

function norm(s) {
  // Folded, letters+digits only (Unicode-aware so Japanese names don't vanish).
  return foldText(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

function hayHas(hayNorm, name) {
  // An empty needle is in every string; a name that folds to nothing never matches.
  const needle = norm(name);
  return needle !== '' && hayNorm.includes(needle);
}

function cleanTitle(t) {
  return String(t || '').replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

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

function canonicalCode(raw) {
  const p = parseCode(raw);
  if (!p) return String(raw || '').trim().toUpperCase();
  return `${p.prefix}-${String(p.num).padStart(Math.max(3, p.digits), '0')}`;
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

function historyHasCode(titles, rawCode) {
  return (titles || []).some(t => releaseMatchesCode(t, rawCode));
}

function performerNameKeys(performer) {
  // Primary name and credited-as always count. Aliases only when multi-word
  // or 6+ folded chars — a short alias like "Mia" substring-matches the world.
  const keys = [];
  const add = n => {
    const k = norm(n);
    if (k && !keys.includes(k)) keys.push(k);
  };
  add(performer?.name);
  add(performer?.as);
  for (const a of performer?.aliases || []) {
    if (a && (/\s/.test(a.trim()) || norm(a).length >= 6)) add(a);
  }
  return keys;
}

const TITLE_STOPWORDS = new Set(['with','from','that','this','your','into','have','when','what',
  'they','them','then','there','their','about','just','will','more','some','over','were','been','here']);

function scoreRelease(title, meta) {
  const hay = norm(`${title || ''}`);
  let score = 0; const hits = [];
  const studio = meta?.studio?.name || '';
  const parent = meta?.studio?.parent?.name || '';
  if (hayHas(hay, studio)) { score++; hits.push('Studio'); }
  else if (hayHas(hay, parent)) { score++; hits.push('Parent studio'); }
  const perfs = meta?.performers || [];
  let pHits = 0;
  for (const p of perfs) {
    if (performerNameKeys(p).some(k => hay.includes(k))) pHits++;
  }
  if (pHits > 0) { score++; hits.push(`Performer ${pHits}/${perfs.length}`); }
  const whole = norm(meta?.title || '');
  let titleHit = whole !== '' && hay.includes(whole);
  if (!titleHit && whole) {
    const words = [...new Set(foldText(meta.title).split(/[^\p{L}\p{N}]+/u)
      .filter(w => w.length >= 4 && !TITLE_STOPWORDS.has(w)))];
    const matched = words.filter(w => hay.includes(norm(w))).length;
    titleHit = words.length > 0 && matched / words.length >= 0.6;
  }
  if (titleHit) { score++; hits.push('Title'); }
  const dm = String(meta?.date || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dm && (hay.includes(`${dm[1]}${dm[2]}${dm[3]}`) || hay.includes(`${dm[1].slice(2)}${dm[2]}${dm[3]}`))) {
    score++; hits.push('Date');
  }
  if (meta?.code && releaseMatchesCode(title, meta.code)) { score++; hits.push('Code'); }
  return { score, hits };
}
// TESTABLE_END

/* ---------------- scene metadata (stash-box GraphQL, both sites) ---------------- */
function sceneIdFromUrl() {
  const m = location.pathname.match(/\/scenes\/([a-f0-9-]{36})/i);
  return m ? m[1] : null;
}

async function fetchSceneMeta(id) {
  const sid = id || sceneIdFromUrl();
  if (!sid) return null;
  const gql = `query { findScene(id: "${sid}") {
    id title code date
    studio { name parent { name } }
    performers { performer { name aliases } as }
    tags { tag { name } }
  } }`;
  const resp = await gmFetch(location.origin + '/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: gql }),
  });
  const data = JSON.parse(resp.responseText);
  if (data?.errors?.length) throw new Error(data.errors[0].message);
  const s = data?.data?.findScene || null;
  if (!s) return null;
  // Flatten performer shape: { name, as, aliases }
  s.performers = (s.performers || []).map(p => ({
    name: p.performer?.name || '', as: p.as || '', aliases: p.performer?.aliases || [],
  })).filter(p => p.name || p.as);
  return s;
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

/* Prowlarr grab history — already-grabbed detection. */
let historyTitlesPromise = null;
function fetchGrabbedTitles() {
  if (!historyTitlesPromise) {
    historyTitlesPromise = (async () => {
      const base = CFG.prowlarrUrl, key = CFG.prowlarrKey;
      if (!base || !key) return [];
      const params = new URLSearchParams({
        apikey: key, page: '1', pageSize: String(CFG.historySize),
        sortKey: 'date', sortDirection: 'descending',
      });
      const resp = await gmFetch(`${base}/api/v1/history?${params}`, { method: 'GET' });
      if (resp.status !== 200) return [];
      const data = JSON.parse(resp.responseText);
      const records = Array.isArray(data) ? data : (data.records || []);
      return records
        .filter(r => /grab/i.test(r.eventType || ''))
        .map(r => r.sourceTitle || r.title || '')
        .filter(Boolean);
    })().catch(e => { console.warn('JavArr history fetch failed:', e); return []; });
  }
  return historyTitlesPromise;
}

function isSkipped(rawCode) {
  const c = canonicalCode(rawCode);
  return CFG.skipCodes.some(s => canonicalCode(s) === c);
}

function addToSkipList(rawCode) {
  const c = canonicalCode(rawCode);
  if (!isSkipped(c)) CFG.skipCodes = [...CFG.skipCodes, c];
}

/* ---------------- stash (owned detection) ---------------- */
const ownedCache = new Map();   // stashId (this site) -> { sceneId, res } | null
let ownedPending = null;

async function stashGraphQL(query, variables) {
  const headers = { 'Content-Type': 'application/json' };
  if (CFG.stashKey) headers['ApiKey'] = CFG.stashKey;
  const resp = await gmFetch(`${CFG.stashUrl}/graphql`, {
    method: 'POST', headers, body: JSON.stringify({ query, variables }),
  });
  if (resp.status !== 200) throw new Error(`Stash HTTP ${resp.status}`);
  const data = JSON.parse(resp.responseText);
  if (data?.errors?.length) throw new Error(data.errors[0].message);
  return data.data;
}

function resLabel(files) {
  const f = (files || [])[0];
  if (!f || !f.height) return '';
  if (f.height >= 2000) return '2160p';
  if (f.height >= 1000) return '1080p';
  if (f.height >= 700) return '720p';
  return `${f.height}p`;
}

/* One GraphQL call resolves a whole page of scene ids against Stash.
   Returns a Map for the requested ids (missing id = not owned). */
async function findOwnedScenes(stashIds) {
  const wanted = [...new Set(stashIds)].filter(id => !ownedCache.has(id));
  if (wanted.length && stashConfigured()) {
    try {
      const q = `query($endpoint: String!, $ids: [String!]!) {
        findScenes(scene_filter: { stash_ids_endpoint: { endpoint: $endpoint, stash_ids: $ids, modifier: EQUALS } },
                   filter: { per_page: -1 }) {
          scenes { id files { width height } stash_ids { endpoint stash_id } }
        } }`;
      const data = await stashGraphQL(q, { endpoint: location.origin + '/graphql', ids: wanted });
      const found = new Map();
      for (const sc of data?.findScenes?.scenes || []) {
        for (const sid of sc.stash_ids || []) {
          if (wanted.includes(sid.stash_id) && !found.has(sid.stash_id)) {
            found.set(sid.stash_id, { sceneId: sc.id, res: resLabel(sc.files) });
          }
        }
      }
      for (const id of wanted) ownedCache.set(id, found.get(id) || null);
    } catch (e) {
      console.warn('JavArr Stash owned-check failed:', e);
      for (const id of wanted) ownedCache.set(id, null);
    }
  }
  const out = new Map();
  for (const id of stashIds) if (ownedCache.get(id)) out.set(id, ownedCache.get(id));
  return out;
}

async function findOwnedScene(stashId) {
  const m = await findOwnedScenes([stashId]);
  return m.get(stashId) || null;
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
    background: #1e1e1e; z-index: 2; gap: 8px; }
  #javarr-panel .q { padding: 8px 16px; color: #888; font-size: 12px; border-bottom: 1px solid #2a2a2a; }
  #javarr-panel .banner { padding: 10px 16px; font-weight: 700; border-bottom: 1px solid #2a2a2a; }
  .banner-owned { color: #4caf50; } .banner-info { color: #ffb300; } .banner-bad { color: #ef5350; }
  .javarr-res { padding: 10px 16px; border-bottom: 1px solid #2a2a2a; }
  .javarr-res .t { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
  .javarr-res .m { color: #999; font-size: 12px; margin-bottom: 6px; }
  .javarr-res .score { color: #4caf50; font-weight: 700; }
  .javarr-dl { background: #2196f3; color: #fff; border: none; border-radius: 4px;
    padding: 6px 12px; cursor: pointer; font-size: 12px; margin-right: 6px; }
  .javarr-dl:hover { background: #1976d2; }
  .javarr-dl.sent { background: #4caf50; }
  .javarr-dl.stage { background: #6a1b9a; } .javarr-dl.stage:hover { background: #4a148c; }
  .javarr-dl.ghost { background: #444; } .javarr-dl.ghost:hover { background: #555; }
  .javarr-group { padding: 6px 16px; background: #2a2a2a; font-weight: 700; color: #bbb;
    position: sticky; top: 41px; }
  .javarr-row { padding: 7px 16px; border-bottom: 1px solid #2a2a2a; font-size: 12px;
    display: flex; gap: 8px; align-items: baseline; }
  .javarr-row .code { font-weight: 700; min-width: 92px; color: #fff; }
  .javarr-row .st-grabbed, .javarr-row .st-owned { color: #4caf50; font-weight: 700; }
  .javarr-row .st-manual, .javarr-row .st-would { color: #ffb300; font-weight: 700; }
  .javarr-row .st-miss { color: #ef5350; font-weight: 700; }
  .javarr-row .st-nocode, .javarr-row .st-error, .javarr-row .st-already, .javarr-row .st-skiplist { color: #999; font-weight: 700; }
  .javarr-row .detail { color: #aaa; word-break: break-all; }
  #javarr-stop { background: #b71c1c; color: #fff; border: none; border-radius: 4px;
    padding: 6px 12px; cursor: pointer; font-size: 12px; }
  .javarr-card-btn { position: absolute; right: 8px; bottom: 8px; z-index: 50;
    background: rgba(233,30,99,.92); color: #fff; border: none; border-radius: 6px;
    padding: 5px 10px; font-size: 12px; font-weight: 700; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.5); }
  .javarr-card-btn:hover { background: rgba(194,24,91,.95); }
  .javarr-card-btn.owned { background: rgba(46,125,50,.92); }
  .javarr-card-btn.busy { background: rgba(90,90,90,.92); cursor: wait; }
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

function panelHeader(titleHtml, extraBtns) {
  return `<header><span>${titleHtml}</span><span>${extraBtns || ''}
    <button id="javarr-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px">✕</button></span></header>`;
}

function wirePanelBasics(panel) {
  const close = $('#javarr-close', panel);
  if (close) close.onclick = () => panel.classList.remove('open');
  $$('.javarr-dl[data-guid]', panel).forEach(b => {
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
  $$('[data-action="exclude"]', panel).forEach(b => {
    b.onclick = () => {
      addToSkipList(b.dataset.code);
      b.textContent = '✓ On skip list';
      b.disabled = true;
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

function ownedBanner(owned) {
  if (!owned) return '';
  const link = `${CFG.stashUrl}/scenes/${owned.sceneId}`;
  return `<div class="banner banner-owned">✓ IN YOUR STASH${owned.res ? ` · ${escapeHtml(owned.res)}` : ''} — <a href="${escapeHtml(link)}" target="_blank" rel="noopener" style="color:#81c784">open in Stash</a></div>`;
}

/* ---------------- StashDB: staged escalating search ----------------
   Stage 1 fires on click (5 parallel queries). Stage 2 ("Try Harder")
   widens to the parent studio and performer aliases. Stage 3 ("Last
   Chance") is a performer-only sweep, unfiltered, sorted by how close
   each release's publish date sits to the scene date. Design adapted
   from brewing8309/stasharr; implementation original. */
let searchSession = null;

function stageQueries(meta, stage) {
  const P = (meta.performers || []).map(p => p.name).filter(Boolean).join(' ');
  const Pa = (meta.performers || []).map(p => (p.aliases && p.aliases[0]) || p.name).filter(Boolean).join(' ');
  const S = meta.studio?.name || '';
  const SP = meta.studio?.parent?.name || '';
  const D = (meta.date || '').slice(0, 10);
  const T = cleanTitle(meta.title || '');
  let qs = [];
  if (stage === 1) {
    qs = [[P, S, D], [P, D], [P, S], [S, D], [T]];
  } else if (stage === 2) {
    qs = [[P, SP, D], [P, SP], [Pa, D]];
  } else if (stage === 3) {
    qs = [[P]];
  }
  return qs.map(parts => parts.filter(Boolean).join(' ').trim()).filter(Boolean);
}

async function runSearchStage(stage) {
  const ses = searchSession;
  if (!ses) return;
  const fresh = stageQueries(ses.meta, stage).filter(q => !ses.tried.has(q));
  for (const q of fresh) ses.tried.add(q);
  ses.stage = stage;
  if (fresh.length) {
    const settled = await Promise.allSettled(fresh.map(q => prowlarrSearch(q)));
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      for (const r of s.value) {
        const key = r.guid || (r.indexer + '|' + r.title);
        if (ses.results.has(key)) continue;
        const { score, hits } = scoreRelease(r.title || r.sortTitle, ses.meta);
        ses.results.set(key, Object.assign({}, r, { score, hits, stage }));
      }
    }
  }
  renderSearchPanel();
}

function sortedSessionResults() {
  const ses = searchSession;
  const all = [...ses.results.values()];
  const strong = all.filter(r => r.score >= 2);
  const weak = all.filter(r => r.score < 2);
  strong.sort((a, b) => (resRank(a.title) - resRank(b.title)) || (b.score - a.score) || (popOf(b) - popOf(a)));
  // Weak results only surface once stage 3 has run; order by publish-date proximity.
  const sceneTime = Date.parse(ses.meta.date || '');
  weak.sort((a, b) => {
    const da = isNaN(sceneTime) ? 0 : Math.abs((Date.parse(a.publishDate || '') || 0) - sceneTime);
    const db = isNaN(sceneTime) ? 0 : Math.abs((Date.parse(b.publishDate || '') || 0) - sceneTime);
    return da - db;
  });
  return { strong, weak: ses.stage >= 3 ? weak.slice(0, 50) : [] };
}

function renderSearchPanel() {
  const ses = searchSession;
  if (!ses) return;
  const panel = getPanel();
  const meta = ses.meta;
  const code = meta.code ? ` [${escapeHtml(meta.code)}]` : '';
  let html = panelHeader(`${escapeHtml(meta.title || '')}${code}`);
  html += ownedBanner(ses.owned);
  if (ses.alreadyInHistory) {
    html += `<div class="banner banner-info">ALREADY GRABBED via Prowlarr (history) — downloading again is your call.</div>`;
  }
  html += `<div class="q">Queries so far: ${[...ses.tried].map(escapeHtml).join(' · ') || '—'}</div>`;
  const { strong, weak } = sortedSessionResults();
  if (!strong.length && !weak.length) {
    html += `<div class="javarr-res">No results yet at this stage.</div>`;
  }
  let lastRes = '';
  for (const r of strong) {
    const res = resolutionOf(r.title);
    if (res !== lastRes) { html += `<div class="javarr-group">${res}</div>`; lastRes = res; }
    html += releaseRow(r, `<span class="score">${r.score}/5 (${r.hits.join(', ') || 'no hits'})</span>`);
  }
  if (weak.length) {
    html += `<div class="javarr-group">Last-chance sweep (unfiltered, nearest date first)</div>`;
    for (const r of weak) html += releaseRow(r, `<span class="score">${r.score}/5</span>`);
  }
  html += `<div class="javarr-res">`;
  if (ses.stage < 2) html += `<button class="javarr-dl stage" id="javarr-stage2">🍆 Try Harder</button>`;
  if (ses.stage < 3) html += `<button class="javarr-dl stage" id="javarr-stage3">🍑 Last Chance</button>`;
  if (meta.code) html += `<button class="javarr-dl ghost" data-action="exclude" data-code="${escapeHtml(meta.code)}">Exclude this code</button>`;
  html += `</div>`;
  panel.innerHTML = html;
  panel.classList.add('open');
  wirePanelBasics(panel);
  const b2 = $('#javarr-stage2', panel);
  if (b2) b2.onclick = async () => { b2.textContent = 'Searching...'; b2.disabled = true; await runSearchStage(2); };
  const b3 = $('#javarr-stage3', panel);
  if (b3) b3.onclick = async () => { b3.textContent = 'Searching...'; b3.disabled = true; await runSearchStage(3); };
}

async function startStashSearch(meta) {
  const owned = meta.id ? await findOwnedScene(meta.id).catch(() => null) : null;
  let alreadyInHistory = false;
  if (meta.code && prowlarrConfigured()) {
    alreadyInHistory = historyHasCode(await fetchGrabbedTitles(), meta.code);
  }
  searchSession = { meta, owned, alreadyInHistory, tried: new Set(), results: new Map(), stage: 0 };
  renderSearchPanel();
  await runSearchStage(1);
}

async function onStashSceneClick(btn) {
  btn.textContent = 'Loading scene...'; btn.disabled = true;
  try {
    const meta = await fetchSceneMeta();
    if (!meta) throw new Error('Could not read scene metadata. Are you logged in?');
    btn.textContent = 'Searching Prowlarr...';
    await startStashSearch(meta);
    btn.textContent = '⬇ Search Prowlarr'; btn.disabled = false;
  } catch (e) {
    btn.textContent = 'Error: ' + e.message; btn.disabled = false;
    setTimeout(() => { btn.textContent = '⬇ Search Prowlarr'; }, 4000);
  }
}

/* ---------------- JavStash: scene page auto-grab ---------------- */
async function onJavSceneClick(btn) {
  btn.textContent = 'Loading scene...'; btn.disabled = true;
  try {
    const meta = await fetchSceneMeta();
    if (!meta) throw new Error('Could not read scene metadata. Are you logged in?');
    if (!meta.code) throw new Error('Scene has no code on JavStash; auto-grab needs one.');
    const owned = meta.id ? await findOwnedScene(meta.id).catch(() => null) : null;
    const skipped = isSkipped(meta.code);
    const already = historyHasCode(await fetchGrabbedTitles(), meta.code);
    btn.textContent = `Searching ${meta.code}...`;
    const all = await searchByCode(meta.code);
    const { best, exact, floorDropped } = pickBest(all, meta.code);
    const panel = getPanel();
    const code = escapeHtml(meta.code);
    let html = panelHeader(`${code} — ${escapeHtml(meta.title || '')}`);
    html += ownedBanner(owned);
    if (skipped) html += `<div class="banner banner-info">ON YOUR SKIP LIST — auto-grab suppressed. Manual picks below still work.</div>`;
    if (already) html += `<div class="banner banner-info">ALREADY GRABBED via Prowlarr (history) — auto-grab suppressed.</div>`;
    const mayAuto = best && !owned && !skipped && !already;
    if (mayAuto) {
      btn.textContent = 'Grabbing...';
      try {
        await prowlarrGrab(best.guid, best.indexerId);
        historyTitlesPromise = null; // refresh history next time
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
    } else if (best) {
      html += `<div class="javarr-group">Exact-code matches (${exact.length}) — pick manually</div>`;
      const sorted = [...exact].sort((a, b) => (resRank(a.title) - resRank(b.title)) || (popOf(b) - popOf(a)));
      for (const r of sorted) html += releaseRow(r, `<span class="score">EXACT</span> ${resolutionOf(r.title)}`);
    } else if (all.length) {
      html += `<div class="q">No exact code match. ${all.length} near results — pick manually:</div>`;
      const scored = all.map(r => Object.assign({}, r, scoreRelease(r.title || r.sortTitle, meta)))
        .sort((a, b) => (b.score - a.score) || (resRank(a.title) - resRank(b.title)));
      for (const r of scored) html += releaseRow(r, `<span class="score">${r.score}/5 (${r.hits.join(', ') || 'no hits'})</span>`);
    } else {
      html += `<div class="javarr-res">No results for ${code} in any form. Nothing to grab.</div>`;
    }
    html += `<div class="javarr-res"><button class="javarr-dl ghost" data-action="exclude" data-code="${code}">Exclude this code</button></div>`;
    panel.innerHTML = html;
    panel.classList.add('open');
    wirePanelBasics(panel);
    btn.textContent = '⬇ Auto-Grab (Code)'; btn.disabled = false;
  } catch (e) {
    btn.textContent = 'Error: ' + e.message; btn.disabled = false;
    setTimeout(() => { btn.textContent = '⬇ Auto-Grab (Code)'; }, 4000);
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

function onBatchClick(btn) {
  if (batchState.running) return;
  const ids = harvestSceneIds().slice(0, CFG.batchLimit);
  const panel = getPanel();
  if (!ids.length) {
    panel.innerHTML = panelHeader('Batch Grab') + `<div class="javarr-res">No scene links found on this page.</div>`;
    panel.classList.add('open');
    wirePanelBasics(panel);
    return;
  }
  panel.innerHTML = panelHeader(`Batch Grab — ${ids.length} scenes on this page`) +
    `<div class="javarr-res">
       <div class="m">Each scene: metadata → skip-list / Stash-owned / Prowlarr-history checks → exact-code search.
       Owned, excluded and already-grabbed codes are never re-grabbed.</div>
       <button class="javarr-dl" id="javarr-batch-start">Start grabbing</button>
       <button class="javarr-dl ghost" id="javarr-batch-scan">Scan only (no grabs)</button>
     </div>`;
  panel.classList.add('open');
  wirePanelBasics(panel);
  $('#javarr-batch-start').onclick = () => runBatch(ids, false, btn);
  $('#javarr-batch-scan').onclick = () => runBatch(ids, true, btn);
}

async function runBatch(ids, scanOnly, btn) {
  batchState = { running: true, stop: false };
  btn.disabled = true;
  const panel = getPanel();
  panel.innerHTML = `<header><span id="javarr-batch-title">Batch${scanOnly ? ' (scan only)' : ''}: 0/${ids.length}</span>
    <span><button id="javarr-stop">Stop</button>
    <button id="javarr-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px">✕</button></span></header>
    <div id="javarr-batch-rows"></div>
    <div class="q" id="javarr-batch-summary">Running...</div>`;
  panel.classList.add('open');
  $('#javarr-close').onclick = () => panel.classList.remove('open');
  $('#javarr-stop').onclick = () => { batchState.stop = true; };
  const rowsEl = $('#javarr-batch-rows');
  const ownedMap = await findOwnedScenes(ids).catch(() => new Map());
  const grabbedTitles = scanOnly ? [] : await fetchGrabbedTitles();
  const tally = { grabbed: 0, would: 0, owned: 0, already: 0, skiplist: 0, manual: 0, miss: 0, nocode: 0, error: 0 };
  const missCodes = [];
  for (let i = 0; i < ids.length; i++) {
    if (batchState.stop) break;
    const title = $('#javarr-batch-title');
    if (title) title.textContent = `Batch${scanOnly ? ' (scan only)' : ''}: ${i + 1}/${ids.length}`;
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
      if (!meta || !meta.code) {
        tally.nocode++;
        setRow(meta?.code, 'st-nocode', 'NO CODE', meta ? (meta.title || '') : 'metadata fetch failed');
      } else if (ownedMap.has(ids[i])) {
        tally.owned++;
        setRow(meta.code, 'st-owned', 'OWNED', `in Stash ${ownedMap.get(ids[i]).res || ''}`.trim());
      } else if (isSkipped(meta.code)) {
        tally.skiplist++;
        setRow(meta.code, 'st-skiplist', 'SKIP LIST', '');
      } else if (!scanOnly && historyHasCode(grabbedTitles, meta.code)) {
        tally.already++;
        setRow(meta.code, 'st-already', 'ALREADY', 'grabbed earlier via Prowlarr');
      } else {
        const all = await searchByCode(meta.code);
        const { best, exact } = pickBest(all, meta.code);
        if (best && scanOnly) {
          tally.would++;
          setRow(meta.code, 'st-would', 'WOULD GRAB', `${best.title} (${fmtSize(best.size)})`);
        } else if (best) {
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
      `Done${batchState.stop ? ' (stopped)' : ''}: ` +
      (scanOnly ? `${tally.would} would grab · ` : `${tally.grabbed} grabbed · `) +
      `${tally.owned} owned · ${tally.already} already · ${tally.skiplist} skip-list · ` +
      `${tally.manual} manual-check · ${tally.miss} misses · ${tally.nocode} no-code · ${tally.error} errors` +
      (missCodes.length ? ` | Misses: ${missCodes.join(', ')}` : '');
  }
  historyTitlesPromise = null;
  batchState.running = false;
  btn.disabled = false;
  refreshButtons();
}

/* ---------------- per-card buttons + owned badges (both sites) ---------------- */
function cardContainer(a) {
  let el = a;
  for (let i = 0; i < 6 && el && el !== document.body; i++) {
    if (el.querySelector && el.querySelector('img') && el.offsetWidth > 80) return el;
    el = el.parentElement;
  }
  return a.parentElement;
}

function harvestCards() {
  const cards = new Map(); // sceneId -> container
  for (const a of $$('a[href*="/scenes/"]')) {
    const m = (a.getAttribute('href') || '').match(/\/scenes\/([a-f0-9-]{36})/i);
    if (!m || cards.has(m[1])) continue;
    const c = cardContainer(a);
    if (c) cards.set(m[1], c);
  }
  return cards;
}

async function onCardButton(btn, sceneId) {
  if (!prowlarrConfigured()) {
    alert('Open the Violentmonkey menu (extension icon) → "JavArr: Configure Prowlarr" first.');
    return;
  }
  btn.textContent = '…'; btn.classList.add('busy'); btn.disabled = true;
  try {
    const meta = await fetchSceneMeta(sceneId);
    if (!meta) throw new Error('no metadata');
    if (isJavStash()) {
      if (!meta.code) { btn.textContent = '✕ no code'; return; }
      if (isSkipped(meta.code)) { btn.textContent = '＝ skipped'; return; }
      if (historyHasCode(await fetchGrabbedTitles(), meta.code)) { btn.textContent = '＝ already'; return; }
      const all = await searchByCode(meta.code);
      const { best } = pickBest(all, meta.code);
      if (!best) { btn.textContent = '✕ miss'; return; }
      await prowlarrGrab(best.guid, best.indexerId);
      historyTitlesPromise = null;
      btn.textContent = '✓ grabbed';
      btn.classList.add('owned');
    } else {
      await startStashSearch(meta);
      btn.textContent = '⬇';
    }
  } catch (e) {
    btn.textContent = '✕ error';
    btn.title = e.message;
  } finally {
    btn.classList.remove('busy');
    btn.disabled = false;
  }
}

let cardScanPending = false;
async function ensureCardButtons() {
  if (isScenePage()) return;
  const cards = harvestCards();
  const fresh = [];
  for (const [sceneId, container] of cards) {
    if (container.dataset.javarrCard) continue;
    container.dataset.javarrCard = sceneId;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'javarr-card-btn';
    btn.textContent = '⬇';
    btn.title = isJavStash() ? 'JavArr: auto-grab this scene by code' : 'JavArr: search Prowlarr for this scene';
    btn.dataset.sceneId = sceneId;
    btn.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); onCardButton(btn, sceneId); };
    container.appendChild(btn);
    fresh.push(sceneId);
  }
  // Owned badges: one Stash query per page batch of new cards.
  if (stashConfigured() && (fresh.length || cards.size) && !cardScanPending) {
    const ids = [...cards.keys()].filter(id => !ownedCache.has(id));
    if (ids.length) {
      cardScanPending = true;
      try {
        const owned = await findOwnedScenes(ids);
        for (const [sceneId, info] of owned) {
          const container = cards.get(sceneId) || document.querySelector(`[data-javarr-card="${sceneId}"]`);
          const btn = container ? $('.javarr-card-btn', container) : null;
          if (btn && info) {
            btn.textContent = `✓ ${info.res || ''}`.trim();
            btn.classList.add('owned');
            btn.title = 'In your Stash — click to open';
            btn.onclick = ev => {
              ev.preventDefault(); ev.stopPropagation();
              window.open(`${CFG.stashUrl}/scenes/${info.sceneId}`, '_blank');
            };
          }
        }
      } finally { cardScanPending = false; }
    }
  }
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
      if (!prowlarrConfigured()) {
        makeButton('javarr-btn', '⚙ Configure JavArr', () => {
          alert('Open the Violentmonkey menu (extension icon) → "JavArr: Configure Prowlarr" to set your Prowlarr URL and API key.');
        });
      } else if (isJavStash()) {
        makeButton('javarr-btn', '⬇ Auto-Grab (Code)', onJavSceneClick);
      } else {
        makeButton('javarr-btn', '⬇ Search Prowlarr', onStashSceneClick);
      }
    }
  } else {
    if (sceneBtn) sceneBtn.remove();
    if (isJavStash()) {
      const n = Math.min(harvestSceneIds().length, CFG.batchLimit);
      if (n > 0) {
        if (!batchBtn) makeButton('javarr-batch-btn', `⬇ Batch Grab (${n})`, onBatchClick);
        else if (!batchState.running) batchBtn.textContent = `⬇ Batch Grab (${n})`;
      } else if (batchBtn && !batchState.running) {
        batchBtn.remove();
      }
    } else if (batchBtn) {
      batchBtn.remove();
    }
    ensureCardButtons();
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refreshButtons(); }, 700);
}

function init() {
  refreshButtons();
  // Both sites are React SPAs: routes and grids render without page loads.
  new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true });
}

init();
})();
