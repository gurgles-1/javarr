// ==UserScript==
// @name         JavArr - scenes to Whisparr
// @namespace    https://github.com/gurgles-1
// @version      3.0.0
// @description  JavStash + StashDB scene pages wired to Whisparr: live status (in Whisparr / has file), Add to Whisparr, Search in Whisparr with grabbable release lists, batch adds from listing pages, Stash-owned badges, skip list.
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

/* v3.0.0: Prowlarr backend removed (Evan's call, Nov 2 2026). Whisparr is
   the only backend: it owns the library, the indexers and the grabbing.
   Design ideas adapted (no code copied) from enymawse/stasharr (GPL-3.0:
   scene-status model, bulk add with confirmation) and brewing8309/stasharr
   (PolyForm Noncommercial: accent folding, Stash-owned card badges).
   Whisparr API shapes verified against enymawse's production client and
   the stash-box / Stash GraphQL schemas on GitHub. */

(function() {
'use strict';

/* ---------------- settings ---------------- */
const CFG = {
  get whisparrUrl() { return GM_getValue('whisparrUrl', ''); },
  get whisparrKey() { return GM_getValue('whisparrKey', ''); },
  get rootFolder()  { return GM_getValue('whisparrRootFolder', ''); },
  get qualityProfileId() {
    const v = GM_getValue('whisparrQualityProfileId', '');
    return v === '' ? null : Number(v);
  },
  get batchLimit()   { return Number(GM_getValue('batchLimit', '60')) || 60; },
  get batchDelayMs() { return Number(GM_getValue('batchDelayMs', '350')) || 350; },
  get stashUrl()     { return GM_getValue('stashUrl', ''); },
  get stashKey()     { return GM_getValue('stashKey', ''); },
  get skipList() {
    try { return JSON.parse(GM_getValue('skipList', '[]')); } catch (e) { return []; }
  },
  set skipList(v) { GM_setValue('skipList', JSON.stringify(v)); },
};
const whisparrConfigured = () => !!(CFG.whisparrUrl && CFG.whisparrKey);
const stashConfigured = () => !!CFG.stashUrl;

GM_registerMenuCommand('JavArr: Configure Whisparr', () => {
  const url = prompt('Whisparr URL (no trailing slash):', CFG.whisparrUrl || 'http://192.168.68.64:6969');
  if (url === null) return;
  const key = prompt('Whisparr API key (Whisparr → Settings → General):', CFG.whisparrKey);
  if (key === null) return;
  GM_setValue('whisparrUrl', url.replace(/\/$/, ''));
  GM_setValue('whisparrKey', key);
  alert('JavArr: Whisparr configured. Root folder + quality profile are picked on your first Add.');
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

GM_registerMenuCommand('JavArr: Reset Whisparr root folder / profile', () => {
  GM_setValue('whisparrRootFolder', '');
  GM_setValue('whisparrQualityProfileId', '');
  alert('JavArr: cleared. You will be asked again on the next Add.');
});

GM_registerMenuCommand('JavArr: Edit skip list', () => {
  const cur = CFG.skipList.join(', ');
  const v = prompt('Skip list — JAV codes or StashDB scene IDs automation must never add (comma-separated). Manual adds from a scene page still work:', cur);
  if (v === null) return;
  CFG.skipList = [...new Set(v.split(',').map(s => s.trim()).filter(Boolean))];
  alert(`JavArr: skip list saved (${CFG.skipList.length} entries).`);
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
  return foldText(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

function parseCode(raw) {
  // "SSIS-001" / "ssis001" / "ABC-12" -> { prefix, num } ; null if not code-shaped.
  // Date-style codes (1pondo / Caribbeancom, e.g. 010126-001) intentionally do not parse.
  const m = String(raw || '').trim().toUpperCase().match(/^([A-Z]{2,8})[-_ ]?(\d{1,5})$/);
  if (!m) return null;
  return { prefix: m[1], num: parseInt(m[2], 10), digits: m[2].length };
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

/* From a Whisparr lookup result set, pick the record belonging to a JAV
   code: an exact code match in the title wins; a lone result is accepted;
   ambiguity with no code match resolves to null (never guess). */
function pickLookupForCode(results, rawCode) {
  const list = (results || []).filter(Boolean);
  if (!list.length) return null;
  const byCode = list.find(r => releaseMatchesCode(r.title || '', rawCode));
  if (byCode) return byCode;
  return list.length === 1 ? list[0] : null;
}

function isSkippedCode(skipList, rawCode) {
  const c = canonicalCode(rawCode);
  return (skipList || []).some(s => canonicalCode(s) === c);
}
// TESTABLE_END

/* ---------------- scene metadata (stash-box GraphQL, both sites) ----------------
   Schema verified against stashapp/stash-box (Nov 2 2026): Scene.date is
   deprecated in favour of release_date; Scene.tags is a flat [Tag!] list
   (no intermediate `tag` field) — tags are not queried at all. */
function sceneIdFromUrl() {
  const m = location.pathname.match(/\/scenes\/([a-f0-9-]{36})/i);
  return m ? m[1] : null;
}

async function fetchSceneMeta(id) {
  const sid = id || sceneIdFromUrl();
  if (!sid) return null;
  const gql = `query { findScene(id: "${sid}") {
    id title code release_date
    studio { name parent { name } }
    performers { performer { name aliases } as }
  } }`;
  const resp = await gmFetch(location.origin + '/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ query: gql }),
  });
  const data = JSON.parse(resp.responseText);
  if (data?.errors?.length) throw new Error(data.errors[0].message);
  const s = data?.data?.findScene || null;
  if (!s) return null;
  s.date = s.release_date || '';
  s.performers = (s.performers || []).map(p => ({
    name: p.performer?.name || '', as: p.as || '', aliases: p.performer?.aliases || [],
  })).filter(p => p.name || p.as);
  return s;
}

/* ---------------- whisparr client ----------------
   API shapes verified against enymawse/stasharr's production client:
   base {url}/api/v3/, X-Api-Key header; scenes live on the `movie`
   resource (Radarr heritage); adds POST the lookup record; searches run
   via the MoviesSearch command. */
async function whisparrReq(path, opts) {
  opts = opts || {};
  const resp = await gmFetch(`${CFG.whisparrUrl}/api/v3/${path}`, {
    method: opts.method || 'GET',
    headers: { 'X-Api-Key': CFG.whisparrKey, 'Content-Type': 'application/json' },
    data: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (resp.status < 200 || resp.status >= 300) {
    let msg = `Whisparr HTTP ${resp.status}`;
    try {
      const j = JSON.parse(resp.responseText);
      const first = Array.isArray(j) ? j[0] : j;
      msg += `: ${(first && (first.errorMessage || first.message || first.propertyName)) || ''}`.trim();
    } catch (e) { /* keep the status-only message */ }
    throw new Error(msg);
  }
  try { return JSON.parse(resp.responseText); } catch (e) { return null; }
}

const asArray = x => (Array.isArray(x) ? x : (x ? [x] : []));
const unwrapMovie = item => (item && item.movie) ? item.movie : item;

/* Scene already in Whisparr? Returns the Whisparr scene record or null. */
async function whisparrGetByStashId(stashId) {
  const res = await whisparrReq(`movie?stashId=${encodeURIComponent(stashId)}`);
  const list = asArray(res).map(unwrapMovie).filter(Boolean);
  return list[0] || null;
}

/* Metadata lookup inside Whisparr (its provider is StashDB). */
async function whisparrLookup(term) {
  const res = await whisparrReq(`lookup/scene?term=${encodeURIComponent(term)}`);
  return asArray(res).map(unwrapMovie).filter(Boolean);
}

async function whisparrLookupByStashId(stashId) {
  const list = await whisparrLookup(`stash:${stashId}`);
  return list.find(r => r.foreignId === stashId) || list[0] || null;
}

/* Whole-library inventory, paged. Cached briefly; invalidated on add. */
let inventoryCache = null; // { at, byStashId: Map }
async function whisparrInventory() {
  if (inventoryCache && (Date.now() - inventoryCache.at) < 5 * 60 * 1000) return inventoryCache.byStashId;
  const byStashId = new Map();
  let page = 1;
  for (;;) {
    const res = await whisparrReq(`movie?page=${page}&pageSize=250`);
    const records = res?.records || asArray(res);
    for (const r of records) {
      const sc = unwrapMovie(r);
      if (sc && sc.stashId) byStashId.set(sc.stashId, sc);
      else if (sc && sc.foreignId) byStashId.set(sc.foreignId, sc);
    }
    const total = res?.totalRecords || records.length;
    if (page * 250 >= total || !records.length) break;
    page++;
  }
  inventoryCache = { at: Date.now(), byStashId };
  return byStashId;
}

async function whisparrAdd(lookupRecord, searchOnAdd) {
  const payload = Object.assign({}, lookupRecord, {
    rootFolderPath: CFG.rootFolder,
    qualityProfileId: CFG.qualityProfileId,
    monitored: true,
    addOptions: { searchForMovie: !!searchOnAdd },
  });
  const added = await whisparrReq('movie', { method: 'POST', body: payload });
  inventoryCache = null;
  return added;
}

async function whisparrSearchNow(whisparrSceneId) {
  return whisparrReq('command', {
    method: 'POST',
    body: { name: 'MoviesSearch', movieIds: [whisparrSceneId] },
  });
}

/* Interactive release list for a scene already in Whisparr. */
async function whisparrReleases(whisparrSceneId) {
  const res = await whisparrReq(`release?movieId=${encodeURIComponent(whisparrSceneId)}`);
  return asArray(res);
}

async function whisparrGrabRelease(guid, indexerId) {
  return whisparrReq('release', { method: 'POST', body: { guid, indexerId } });
}

/* Root folder + quality profile: fetched once, picked in-panel when
   Whisparr offers more than one, then remembered. */
async function ensureWhisparrDefaults(panel) {
  if (CFG.rootFolder && CFG.qualityProfileId != null) return true;
  const [roots, profiles] = await Promise.all([
    whisparrReq('rootFolder'), whisparrReq('qualityProfile'),
  ]);
  const rootList = asArray(roots);
  const profList = asArray(profiles);
  if (!rootList.length || !profList.length) throw new Error('Whisparr has no root folder or quality profile configured.');
  if (rootList.length === 1 && profList.length === 1) {
    GM_setValue('whisparrRootFolder', rootList[0].path);
    GM_setValue('whisparrQualityProfileId', profList[0].id);
    return true;
  }
  return new Promise(resolve => {
    const box = document.createElement('div');
    box.className = 'javarr-res';
    box.innerHTML = `<div class="t">First add: choose where Whisparr puts scenes</div>
      <div class="m">Root folder</div>
      <select id="javarr-root" style="width:100%;margin-bottom:8px">${rootList.map(r =>
        `<option value="${escapeHtml(r.path)}" ${CFG.rootFolder === r.path ? 'selected' : ''}>${escapeHtml(r.path)}</option>`).join('')}</select>
      <div class="m">Quality profile</div>
      <select id="javarr-prof" style="width:100%;margin-bottom:8px">${profList.map(p =>
        `<option value="${p.id}" ${CFG.qualityProfileId === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
      <button class="javarr-dl" id="javarr-defaults-save">Save & continue</button>`;
    panel.appendChild(box);
    box.scrollIntoView({ block: 'nearest' });
    $('#javarr-defaults-save', box).onclick = () => {
      GM_setValue('whisparrRootFolder', $('#javarr-root', box).value);
      GM_setValue('whisparrQualityProfileId', Number($('#javarr-prof', box).value));
      box.remove();
      resolve(true);
    };
  });
}

/* ---------------- stash (owned detection) ---------------- */
const ownedCache = new Map();   // stashId (this site) -> { sceneId, res } | null

async function stashGraphQL(query, variables) {
  const headers = { 'Content-Type': 'application/json' };
  if (CFG.stashKey) headers['ApiKey'] = CFG.stashKey;
  const resp = await gmFetch(`${CFG.stashUrl}/graphql`, {
    method: 'POST', headers, data: JSON.stringify({ query, variables }),
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
  .banner-whisparr { color: #64b5f6; }
  .javarr-res { padding: 10px 16px; border-bottom: 1px solid #2a2a2a; }
  .javarr-res .t { font-weight: 600; margin-bottom: 4px; word-break: break-all; }
  .javarr-res .m { color: #999; font-size: 12px; margin-bottom: 6px; }
  .javarr-dl { background: #2196f3; color: #fff; border: none; border-radius: 4px;
    padding: 6px 12px; cursor: pointer; font-size: 12px; margin-right: 6px; }
  .javarr-dl:hover { background: #1976d2; }
  .javarr-dl.sent { background: #4caf50; }
  .javarr-dl.ghost { background: #444; } .javarr-dl.ghost:hover { background: #555; }
  .javarr-dl:disabled { background: #666; cursor: wait; }
  .javarr-group { padding: 6px 16px; background: #2a2a2a; font-weight: 700; color: #bbb; }
  .javarr-row { padding: 7px 16px; border-bottom: 1px solid #2a2a2a; font-size: 12px;
    display: flex; gap: 8px; align-items: baseline; }
  .javarr-row .code { font-weight: 700; min-width: 92px; color: #fff; }
  .javarr-row .st-ok { color: #4caf50; font-weight: 700; }
  .javarr-row .st-info { color: #64b5f6; font-weight: 700; }
  .javarr-row .st-warn { color: #ffb300; font-weight: 700; }
  .javarr-row .st-bad { color: #ef5350; font-weight: 700; }
  .javarr-row .st-dim { color: #999; font-weight: 700; }
  .javarr-row .detail { color: #aaa; word-break: break-all; }
  #javarr-stop { background: #b71c1c; color: #fff; border: none; border-radius: 4px;
    padding: 6px 12px; cursor: pointer; font-size: 12px; }
  .javarr-card-btn { position: absolute; right: 8px; bottom: 8px; z-index: 50;
    background: rgba(233,30,99,.92); color: #fff; border: none; border-radius: 6px;
    padding: 5px 10px; font-size: 12px; font-weight: 700; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.5); }
  .javarr-card-btn:hover { background: rgba(194,24,91,.95); }
  .javarr-card-btn.owned { background: rgba(46,125,50,.92); }
  .javarr-card-btn.inlib { background: rgba(25,118,210,.92); }
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

function panelHeader(titleHtml) {
  return `<header><span>${titleHtml}</span><span>
    <button id="javarr-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:16px">✕</button></span></header>`;
}

function wireClose(panel) {
  const close = $('#javarr-close', panel);
  if (close) close.onclick = () => panel.classList.remove('open');
}

function ownedBanner(owned) {
  if (!owned) return '';
  const link = `${CFG.stashUrl}/scenes/${owned.sceneId}`;
  return `<div class="banner banner-owned">✓ IN YOUR STASH${owned.res ? ` · ${escapeHtml(owned.res)}` : ''} — <a href="${escapeHtml(link)}" target="_blank" rel="noopener" style="color:#81c784">open in Stash</a></div>`;
}

function isSkippedFor(meta) {
  if (meta.code && isSkippedCode(CFG.skipList, meta.code)) return true;
  if (meta.id && CFG.skipList.includes(meta.id)) return true;
  return false;
}

function addSkipEntry(meta) {
  const entry = meta.code ? canonicalCode(meta.code) : meta.id;
  if (entry && !CFG.skipList.includes(entry)) CFG.skipList = [...CFG.skipList, entry];
}

/* ---------------- scene resolution ----------------
   Returns { stashId, lookup, existing }:
   - StashDB pages: the page's own scene id IS the StashDB id Whisparr keys on.
   - JavStash pages: bridge by code through Whisparr's own lookup; the
     resolved record's foreignId is the StashDB id. Unresolvable = null stashId. */
async function resolveInWhisparr(meta) {
  if (!isJavStash()) {
    const stashId = meta.id;
    const existing = await whisparrGetByStashId(stashId);
    const lookup = existing ? null : await whisparrLookupByStashId(stashId);
    return { stashId, lookup, existing };
  }
  if (!meta.code) return { stashId: null, lookup: null, existing: null };
  const results = await whisparrLookup(meta.code);
  const pick = pickLookupForCode(results, meta.code);
  if (!pick) return { stashId: null, lookup: null, existing: null };
  const stashId = pick.foreignId || null;
  const existing = stashId ? await whisparrGetByStashId(stashId) : null;
  return { stashId, lookup: existing ? null : pick, existing };
}

function whisparrStatusBanner(existing) {
  if (!existing) return '';
  if (existing.hasFile) {
    const q = existing.movieFile?.quality?.quality?.name || existing.movieFile?.quality?.name || '';
    return `<div class="banner banner-whisparr">▣ IN WHISPARR · HAS FILE${q ? ` · ${escapeHtml(q)}` : ''}</div>`;
  }
  return `<div class="banner banner-whisparr">▣ IN WHISPARR · monitored, no file yet</div>`;
}

/* ---------------- scene page flow ---------------- */
async function onSceneClick(btn) {
  btn.textContent = 'Loading scene...'; btn.disabled = true;
  const panel = getPanel();
  try {
    const meta = await fetchSceneMeta();
    if (!meta) throw new Error('Could not read scene metadata. Are you logged in?');
    const owned = meta.id ? await findOwnedScene(meta.id).catch(() => null) : null;
    const skipped = isSkippedFor(meta);
    btn.textContent = 'Checking Whisparr...';
    const { stashId, lookup, existing } = await resolveInWhisparr(meta);
    const code = meta.code ? ` [${escapeHtml(meta.code)}]` : '';
    let html = panelHeader(`${escapeHtml(meta.title || '')}${code}`);
    html += ownedBanner(owned);
    html += whisparrStatusBanner(existing);
    if (skipped) html += `<div class="banner banner-info">ON YOUR SKIP LIST — automatic adds suppressed. Buttons below still work if you insist.</div>`;
    if (!stashId && !existing) {
      html += `<div class="javarr-res"><div class="t" style="color:#ef5350">Not in Whisparr's metadata</div>
        <div class="m">Whisparr (StashDB) has no record matching this scene${meta.code ? ` for code ${escapeHtml(meta.code)}` : ''}, so it can't be added from here.</div></div>`;
    } else if (existing && !existing.hasFile) {
      html += `<div class="javarr-res">
        <button class="javarr-dl" id="javarr-search-now">🔎 Search in Whisparr now</button>
        <button class="javarr-dl ghost" id="javarr-show-releases">Show releases</button>
        <span class="m">Search fires Whisparr's own automatic search; Show releases lists what its indexers return, for a manual grab.</span>
      </div><div id="javarr-releases"></div>`;
    } else if (!existing) {
      html += `<div class="javarr-res">
        <button class="javarr-dl" id="javarr-add-search">➕ Add to Whisparr + Search</button>
        <button class="javarr-dl ghost" id="javarr-add-only">Add only</button>
      </div>`;
    } else {
      html += `<div class="javarr-res">
        <button class="javarr-dl ghost" id="javarr-show-releases">Show releases</button>
        <span class="m">Already downloaded. The release list is there if you want a different copy — grabbing another release is Whisparr's call from its own UI.</span>
      </div><div id="javarr-releases"></div>`;
    }
    html += `<div class="javarr-res"><button class="javarr-dl ghost" data-action="exclude">Exclude this scene</button></div>`;
    panel.innerHTML = html;
    panel.classList.add('open');
    wireClose(panel);
    $$('[data-action="exclude"]', panel).forEach(b => {
      b.onclick = () => { addSkipEntry(meta); b.textContent = '✓ On skip list'; b.disabled = true; };
    });
    const addFlow = async searchOnAdd => {
      const ok = await ensureWhisparrDefaults(panel);
      if (!ok) return;
      const added = await whisparrAdd(lookup, searchOnAdd);
      panel.innerHTML = panelHeader(`${escapeHtml(meta.title || '')}${code}`) + ownedBanner(owned) +
        whisparrStatusBanner(added || { hasFile: false }) +
        `<div class="javarr-res"><div class="t" style="color:#4caf50">✓ ADDED TO WHISPARR${searchOnAdd ? ' · search triggered' : ''}</div>
         <div class="m">Monitored, in ${escapeHtml(CFG.rootFolder)}. ${searchOnAdd ? 'Whisparr is searching its indexers now.' : 'Use Search from Whisparr when you want it to look.'}</div></div>`;
      wireClose(panel);
    };
    const addSearch = $('#javarr-add-search', panel);
    if (addSearch) addSearch.onclick = async () => {
      addSearch.textContent = 'Adding...'; addSearch.disabled = true;
      try { await addFlow(true); } catch (e) { addSearch.textContent = 'Failed: ' + e.message; addSearch.disabled = false; }
    };
    const addOnly = $('#javarr-add-only', panel);
    if (addOnly) addOnly.onclick = async () => {
      addOnly.textContent = 'Adding...'; addOnly.disabled = true;
      try { await addFlow(false); } catch (e) { addOnly.textContent = 'Failed: ' + e.message; addOnly.disabled = false; }
    };
    const searchNow = $('#javarr-search-now', panel);
    if (searchNow && existing) searchNow.onclick = async () => {
      searchNow.textContent = 'Triggering...'; searchNow.disabled = true;
      try {
        await whisparrSearchNow(existing.id);
        searchNow.textContent = '✓ Search running in Whisparr';
        searchNow.classList.add('sent');
      } catch (e) { searchNow.textContent = 'Failed: ' + e.message; searchNow.disabled = false; }
    };
    const showRel = $('#javarr-show-releases', panel);
    if (showRel && existing) showRel.onclick = () => renderReleases(existing.id, showRel);
    btn.textContent = '⬇ Whisparr'; btn.disabled = false;
  } catch (e) {
    panel.innerHTML = panelHeader('JavArr') +
      `<div class="javarr-res"><div class="t" style="color:#ef5350">Error: ${escapeHtml(e.message)}</div>
       <div class="m">If this is a connection error, check the Whisparr URL/API key in the Violentmonkey menu.</div></div>`;
    panel.classList.add('open');
    wireClose(panel);
    btn.textContent = '⬇ Whisparr'; btn.disabled = false;
  }
}

async function renderReleases(whisparrSceneId, btn) {
  const slot = $('#javarr-releases');
  if (!slot) return;
  btn.textContent = 'Fetching releases...'; btn.disabled = true;
  try {
    const releases = await whisparrReleases(whisparrSceneId);
    if (!releases.length) {
      slot.innerHTML = `<div class="javarr-res">Whisparr's indexers returned nothing for this scene right now.</div>`;
      return;
    }
    const sorted = [...releases].sort((a, b) =>
      ((a.rejected ? 1 : 0) - (b.rejected ? 1 : 0)) ||
      (resRank(a.title) - resRank(b.title)) ||
      (popOf(b) - popOf(a)));
    let html = ''; let lastRes = '';
    for (const r of sorted) {
      const res = resolutionOf(r.title);
      if (res !== lastRes) { html += `<div class="javarr-group">${res}</div>`; lastRes = res; }
      const q = r.quality?.quality?.name ? ` · ${escapeHtml(r.quality.quality.name)}` : '';
      const pop = r.seeders != null ? `${r.seeders} seeders` : (r.grabs != null ? `${r.grabs} grabs` : '');
      const rej = r.rejected ? `<div class="m" style="color:#ef5350">Rejected by Whisparr: ${escapeHtml((r.rejections || []).join('; ') || 'see Whisparr')}</div>` : '';
      html += `<div class="javarr-res">
        <div class="t">${escapeHtml(r.title)}</div>
        <div class="m">${escapeHtml(r.indexer || '')}${q} · ${fmtSize(r.size)} · ${pop}</div>${rej}
        <button class="javarr-dl javarr-grab" data-guid="${escapeHtml(r.guid)}" data-idx="${r.indexerId}" ${r.rejected ? 'disabled title="Whisparr rejected this release"' : ''}>Download</button>
      </div>`;
    }
    slot.innerHTML = html;
    $$('.javarr-grab', slot).forEach(b => {
      b.onclick = async () => {
        b.textContent = 'Sending...'; b.disabled = true;
        try {
          await whisparrGrabRelease(b.dataset.guid, Number(b.dataset.idx));
          b.textContent = '✓ Sent'; b.classList.add('sent');
        } catch (e) { b.textContent = 'Failed: ' + e.message; b.disabled = false; }
      };
    });
  } catch (e) {
    slot.innerHTML = `<div class="javarr-res"><div class="t" style="color:#ef5350">Release list failed: ${escapeHtml(e.message)}</div>
      <div class="m">The automatic Search button above uses a different, verified path — that one works even if this list doesn't.</div></div>`;
  } finally {
    btn.textContent = 'Show releases'; btn.disabled = false;
  }
}

/* ---------------- listing pages: batch add ---------------- */
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
    panel.innerHTML = panelHeader('Batch Add') + `<div class="javarr-res">No scene links found on this page.</div>`;
    panel.classList.add('open');
    wireClose(panel);
    return;
  }
  panel.innerHTML = panelHeader(`Batch Add — ${ids.length} scenes on this page`) +
    `<div class="javarr-res">
       <div class="m">Each scene is checked against your skip list, your Stash library and Whisparr's
       library before anything is added. Scenes already in Whisparr are never re-added.</div>
       <button class="javarr-dl" id="javarr-batch-start">Start adding (+ search)</button>
       <button class="javarr-dl ghost" id="javarr-batch-scan">Scan only (no changes)</button>
     </div>`;
  panel.classList.add('open');
  wireClose(panel);
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
    <div class="q" id="javarr-batch-summary">Loading Whisparr inventory + Stash ownership...</div>`;
  panel.classList.add('open');
  $('#javarr-close').onclick = () => panel.classList.remove('open');
  $('#javarr-stop').onclick = () => { batchState.stop = true; };
  const rowsEl = $('#javarr-batch-rows');
  const ownedMap = await findOwnedScenes(ids).catch(() => new Map());
  const inventory = await whisparrInventory().catch(() => new Map());
  if (!scanOnly) {
    try { await ensureWhisparrDefaults(panel); }
    catch (e) {
      $('#javarr-batch-summary').textContent = 'Cannot add: ' + e.message;
      batchState.running = false; btn.disabled = false; return;
    }
  }
  const tally = { added: 0, would: 0, hasfile: 0, inlib: 0, owned: 0, skip: 0, notmeta: 0, nocode: 0, error: 0 };
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
      const label = meta?.code || (meta?.title ? meta.title.slice(0, 28) : ids[i].slice(0, 8));
      if (!meta) { tally.error++; setRow(label, 'st-bad', 'ERROR', 'metadata fetch failed'); }
      else if (isSkippedFor(meta)) { tally.skip++; setRow(label, 'st-dim', 'SKIP LIST', ''); }
      else if (ownedMap.has(ids[i])) { tally.owned++; setRow(label, 'st-ok', 'OWNED', `in Stash ${ownedMap.get(ids[i]).res || ''}`.trim()); }
      else {
        let stashId = null, lookup = null;
        if (isJavStash()) {
          if (!meta.code) { tally.nocode++; setRow(label, 'st-dim', 'NO CODE', meta.title || ''); stashId = undefined; }
          else {
            const pick = pickLookupForCode(await whisparrLookup(meta.code), meta.code);
            if (pick) { stashId = pick.foreignId; lookup = pick; }
          }
        } else {
          stashId = meta.id;
        }
        if (stashId !== undefined) {
          const existing = stashId ? (inventory.get(stashId) || await whisparrGetByStashId(stashId).catch(() => null)) : null;
          if (existing && existing.hasFile) { tally.hasfile++; setRow(label, 'st-ok', 'HAS FILE', 'already in Whisparr'); }
          else if (existing) { tally.inlib++; setRow(label, 'st-info', 'IN WHISPARR', 'monitored, no file yet'); }
          else if (!stashId) { tally.notmeta++; setRow(label, 'st-bad', 'NOT IN METADATA', 'Whisparr/StashDB has no match'); }
          else {
            if (!lookup) lookup = await whisparrLookupByStashId(stashId);
            if (!lookup) { tally.notmeta++; setRow(label, 'st-bad', 'NOT IN METADATA', 'lookup returned nothing'); }
            else if (scanOnly) { tally.would++; setRow(label, 'st-warn', 'WOULD ADD', lookup.title || ''); }
            else {
              const added = await whisparrAdd(lookup, true);
              inventory.set(stashId, added || lookup);
              tally.added++;
              setRow(label, 'st-ok', 'ADDED', '+ search triggered');
            }
          }
        }
      }
    } catch (e) {
      tally.error++;
      setRow(null, 'st-bad', 'ERROR', e.message);
    }
    if (i < ids.length - 1 && !batchState.stop) await sleep(CFG.batchDelayMs);
  }
  const summary = $('#javarr-batch-summary');
  if (summary) {
    summary.textContent =
      `Done${batchState.stop ? ' (stopped)' : ''}: ` +
      (scanOnly ? `${tally.would} would add · ` : `${tally.added} added · `) +
      `${tally.hasfile} has file · ${tally.inlib} in Whisparr · ${tally.owned} owned in Stash · ` +
      `${tally.skip} skip-list · ${tally.notmeta} not in metadata · ${tally.nocode} no-code · ${tally.error} errors`;
  }
  batchState.running = false;
  btn.disabled = false;
  refreshButtons();
}

/* ---------------- per-card buttons + badges (both sites) ---------------- */
function cardContainer(a) {
  // stash-box cards carry a stable class (verified in stash-box source).
  const card = a.closest('.SceneCard');
  if (card) return card;
  let el = a;
  for (let i = 0; i < 6 && el && el !== document.body; i++) {
    if (el.querySelector && el.querySelector('img') && el.offsetWidth > 80) return el;
    el = el.parentElement;
  }
  return a.parentElement;
}

function harvestCards() {
  const cards = new Map();
  for (const a of $$('a[href*="/scenes/"]')) {
    const m = (a.getAttribute('href') || '').match(/\/scenes\/([a-f0-9-]{36})/i);
    if (!m || cards.has(m[1])) continue;
    const c = cardContainer(a);
    if (c) cards.set(m[1], c);
  }
  return cards;
}

async function onCardButton(btn, sceneId) {
  if (!whisparrConfigured()) {
    alert('Open the Violentmonkey menu (extension icon) → "JavArr: Configure Whisparr" first.');
    return;
  }
  btn.textContent = '…'; btn.classList.add('busy'); btn.disabled = true;
  try {
    const meta = await fetchSceneMeta(sceneId);
    if (!meta) throw new Error('no metadata');
    if (isSkippedFor(meta)) { btn.textContent = '＝ skipped'; return; }
    const owned = await findOwnedScene(sceneId).catch(() => null);
    if (owned) {
      btn.textContent = `✓ ${owned.res || ''}`.trim();
      btn.classList.add('owned');
      return;
    }
    const { stashId, lookup, existing } = await resolveInWhisparr(meta);
    if (existing && existing.hasFile) { btn.textContent = '✓ file'; btn.classList.add('inlib'); return; }
    if (existing) { btn.textContent = '＝ in Whisparr'; btn.classList.add('inlib'); return; }
    if (!stashId || !lookup) { btn.textContent = '✕ not in Whisparr'; return; }
    const panel = getPanel(); // defaults picker needs a surface; use the panel hidden-open trick
    panel.classList.add('open');
    const ok = await ensureWhisparrDefaults(panel);
    if (!ok) { btn.textContent = '⬇'; return; }
    await whisparrAdd(lookup, true);
    btn.textContent = '✓ added';
    btn.classList.add('inlib');
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
  for (const [sceneId, container] of cards) {
    if (container.dataset.javarrCard) continue;
    container.dataset.javarrCard = sceneId;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'javarr-card-btn';
    btn.textContent = '⬇';
    btn.title = 'JavArr: add this scene to Whisparr (+ search)';
    btn.dataset.sceneId = sceneId;
    btn.onclick = ev => { ev.preventDefault(); ev.stopPropagation(); onCardButton(btn, sceneId); };
    container.appendChild(btn);
  }
  if (cardScanPending || !cards.size) return;
  const ids = [...cards.keys()];
  const needStash = stashConfigured() && ids.some(id => !ownedCache.has(id));
  const needWhisparr = whisparrConfigured() && !isJavStash();
  if (!needStash && !needWhisparr) return;
  cardScanPending = true;
  try {
    const [owned, inventory] = await Promise.all([
      needStash ? findOwnedScenes(ids).catch(() => new Map()) : Promise.resolve(new Map()),
      needWhisparr ? whisparrInventory().catch(() => new Map()) : Promise.resolve(new Map()),
    ]);
    for (const sceneId of ids) {
      const container = cards.get(sceneId) || document.querySelector(`[data-javarr-card="${sceneId}"]`);
      const btn = container ? $('.javarr-card-btn', container) : null;
      if (!btn || btn.classList.contains('owned') || btn.classList.contains('inlib')) continue;
      const own = owned.get(sceneId);
      if (own) {
        btn.textContent = `✓ ${own.res || ''}`.trim();
        btn.classList.add('owned');
        btn.title = 'In your Stash — click to open';
        btn.onclick = ev => {
          ev.preventDefault(); ev.stopPropagation();
          window.open(`${CFG.stashUrl}/scenes/${own.sceneId}`, '_blank');
        };
        continue;
      }
      const w = inventory.get(sceneId);
      if (w) {
        btn.textContent = w.hasFile ? '✓ file' : '＝ in Whisparr';
        btn.classList.add('inlib');
        btn.title = w.hasFile ? 'In Whisparr with a file' : 'In Whisparr, no file yet — click a scene page to search';
      }
    }
  } finally { cardScanPending = false; }
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
      if (!whisparrConfigured()) {
        makeButton('javarr-btn', '⚙ Configure JavArr', () => {
          alert('Open the Violentmonkey menu (extension icon) → "JavArr: Configure Whisparr" to set your Whisparr URL and API key.');
        });
      } else {
        makeButton('javarr-btn', '⬇ Whisparr', onSceneClick);
      }
    }
  } else {
    if (sceneBtn) sceneBtn.remove();
    const n = Math.min(harvestSceneIds().length, CFG.batchLimit);
    if (n > 0 && whisparrConfigured()) {
      if (!batchBtn) makeButton('javarr-batch-btn', `⬇ Batch Add (${n})`, onBatchClick);
      else if (!batchState.running) batchBtn.textContent = `⬇ Batch Add (${n})`;
    } else if (batchBtn && !batchState.running) {
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
  new MutationObserver(scheduleRefresh).observe(document.body, { childList: true, subtree: true });
}

init();
})();
