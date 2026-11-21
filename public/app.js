// LaunchLoop SPA — vanilla JS, no build step.
const S = {
  health: null,
  config: null,
  workspaces: [],
  wsId: null,
  ws: null,
  channels: [],
  campaigns: [],
  cmpId: null,
  campaign: null,
  assets: [],
  tasks: [],
  progress: null,
  ui: { studioFormat: 'all', studioState: 'all', taskCat: 'all', taskView: 'timeline', hideDone: false },
};
const STATE_LABEL = { DRAFT: 'Draft', NEEDS_REVIEW: 'Needs review', NEEDS_REVISION: 'Needs revision', APPROVED: 'Approved', SCHEDULED: 'Scheduled', PUBLISHED: 'Published', FAILED: 'Failed' };
const STATE_COLOR = { DRAFT: '#cfc9bf', NEEDS_REVIEW: '#2f5fb3', NEEDS_REVISION: '#b7791f', APPROVED: '#1f8a5b', SCHEDULED: '#6b4fc4', PUBLISHED: '#16191e', FAILED: '#c4362c' };
const CAT_CLASS = (c) => 'cat-' + c.split(/[ /]/)[0];

// ------------------------------------------------------------------ utils
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ch = (k) => S.config?.channels[k] || { label: k };
const fmtLabel = (f) => S.config?.formats[f]?.label || f;
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const num = (n) => new Intl.NumberFormat(locale()).format(n || 0);
const locale = () => `${S.ws?.locale?.language || 'en'}-${S.ws?.locale?.region || 'US'}`;
const todayIso = () => new Date().toISOString().slice(0, 10);

function fmtDate(iso, { time = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso);
  const f = S.ws?.locale?.dateFormat || 'MMM D, YYYY';
  const p = (n) => String(n).padStart(2, '0');
  const parts = { YYYY: d.getFullYear(), MM: p(d.getMonth() + 1), DD: p(d.getDate()), D: d.getDate(), MMM: d.toLocaleString(locale(), { month: 'short' }) };
  let out = f.replace(/YYYY|MMM|MM|DD|D/g, (t) => parts[t]);
  if (time) out += ' · ' + d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  return out;
}
const isoPretty = (msg) => String(msg).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (iso) => fmtDate(iso, { time: true }));
function rel(iso) {
  const diff = (new Date(iso) - Date.now()) / 1000;
  const a = Math.abs(diff);
  const u = a < 60 ? [Math.round(diff), 'second'] : a < 3600 ? [Math.round(diff / 60), 'minute'] : a < 86400 ? [Math.round(diff / 3600), 'hour'] : [Math.round(diff / 86400), 'day'];
  return new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' }).format(u[0], u[1]);
}
function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return new Intl.NumberFormat(locale(), { style: 'currency', currency: S.ws?.locale?.currency || 'USD' }).format(n);
}
const toLocalInput = (d) => {
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
};

async function api(method, url, body) {
  const headers = { 'content-type': 'application/json' };
  const tok = localStorage.getItem('ll_token');
  if (tok) headers.authorization = `Bearer ${tok}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && !url.includes('/webhooks/')) {
    const t = prompt('This LaunchLoop instance requires an API token (APP_API_TOKEN):');
    if (t) {
      localStorage.setItem('ll_token', t);
      return api(method, url, body);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
async function busy(btn, fn) {
  btn?.classList.add('busy');
  try {
    return await fn();
  } catch (e) {
    toast(e.message, 'bad');
    throw e;
  } finally {
    btn?.classList.remove('busy');
  }
}
const badge = (state) => `<span class="badge s-${state}">${STATE_LABEL[state] || state}</span>`;
function scorePill(score) {
  const o = score?.overall ?? 0;
  return `<span class="score" title="Hook & virality score"><i class="${o >= 75 ? 'sc-hi' : o >= 55 ? 'sc-mid' : 'sc-lo'}">${o}</i>score</span>`;
}
const mediaUrl = (a, slide = 0) => `/api/assets/${a.id}/media.svg?slide=${slide}&v=${a.version}-${encodeURIComponent(a.updated_at || '')}`;
const modeBadge = (c) => (!c ? '' : c.mode === 'api' ? `<span class="badge b-api">API${c.status === 'mock' ? ' · mock' : ''}</span>` : `<span class="badge b-kit">Share Kit</span>`);
const conn = (channel) => S.channels.find((c) => c.channel === channel);

// ------------------------------------------------------------------ data loading
async function boot() {
  [S.health, S.config] = await Promise.all([api('GET', '/api/health'), api('GET', '/api/config')]);
  renderModes();
  await loadWorkspaces();
  window.addEventListener('hashchange', render);
  setInterval(poll, 8000);
}
async function loadWorkspaces(selectId) {
  S.workspaces = await api('GET', '/api/workspaces');
  S.wsId = selectId || (S.workspaces.find((w) => w.id === localStorage.getItem('ll_ws')) || S.workspaces[0])?.id || null;
  await loadWorkspace();
}
async function loadWorkspace(selectCmp) {
  if (!S.wsId) return render();
  localStorage.setItem('ll_ws', S.wsId);
  [S.ws, S.channels, S.campaigns] = await Promise.all([api('GET', `/api/workspaces/${S.wsId}`), api('GET', `/api/workspaces/${S.wsId}/channels`), api('GET', `/api/workspaces/${S.wsId}/campaigns`)]);
  S.cmpId = selectCmp || (S.campaigns.find((c) => c.id === localStorage.getItem('ll_cmp')) || S.campaigns[0])?.id || null;
  await loadCampaign();
}
async function loadCampaign() {
  renderSelectors();
  if (!S.cmpId) {
    S.campaign = null;
    S.assets = [];
    S.tasks = [];
    S.progress = null;
    return render();
  }
  localStorage.setItem('ll_cmp', S.cmpId);
  await refreshCampaign();
  render();
}
async function refreshCampaign() {
  const [assets, tasks, progress] = await Promise.all([api('GET', `/api/campaigns/${S.cmpId}/assets`), api('GET', `/api/campaigns/${S.cmpId}/tasks`), api('GET', `/api/campaigns/${S.cmpId}/progress`)]);
  const changed = JSON.stringify([assets.map((a) => [a.id, a.state, a.updated_at]), tasks.map((t) => [t.id, t.done, t.updated_at]), progress.metrics.totals, progress.activity[0]?.at]) !== S._sig;
  S._sig = JSON.stringify([assets.map((a) => [a.id, a.state, a.updated_at]), tasks.map((t) => [t.id, t.done, t.updated_at]), progress.metrics.totals, progress.activity[0]?.at]);
  Object.assign(S, { assets, tasks, progress, campaign: progress.campaign });
  $('#reviewCount').textContent = S.progress.assets.states.NEEDS_REVIEW || '';
  return changed;
}
async function poll() {
  if (!S.cmpId || document.hidden || $('#modal-root').children.length) return;
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && $('#view').contains(active)) return;
  const prev = S.progress?.assets.states;
  const changed = await refreshCampaign().catch(() => false);
  if (!changed) return;
  if (prev && S.progress.assets.states.PUBLISHED > prev.PUBLISHED) toast('Scheduler published a creative ✓', 'ok');
  if (['dashboard', 'review', 'timeline', 'analytics', 'studio'].includes(route())) render();
}

function renderModes() {
  const h = S.health;
  $('#modes').innerHTML = `
    <div class="mode-pill"><span><span class="dot ${h.ai.provider !== 'mock' ? 'live' : ''}"></span>AI</span><b>${esc(h.ai.provider)}${h.ai.model ? ' · ' + esc(h.ai.model) : ''}</b></div>
    <div class="mode-pill"><span><span class="dot ${h.publishMode === 'live' ? 'live' : ''}"></span>Publishing</span><b>${esc(h.publishMode)}</b></div>
    <div class="mode-pill"><span>Scheduler</span><b>every ${Math.round(h.worker.intervalMs / 1000)}s</b></div>`;
}
function renderSelectors() {
  $('#wsSelect').innerHTML = S.workspaces.map((w) => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  $('#cmpSelect').innerHTML = S.campaigns.length ? S.campaigns.map((c) => `<option value="${c.id}" ${c.id === S.cmpId ? 'selected' : ''}>${esc(c.name)}</option>`).join('') : '<option>No campaigns yet</option>';
}

// ------------------------------------------------------------------ router
const route = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard');
const VIEWS = { dashboard: viewDashboard, workspace: viewWorkspace, studio: viewStudio, review: viewReview, timeline: viewTimeline, analytics: viewAnalytics };
function render() {
  const r = VIEWS[route()] ? route() : 'dashboard';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === r));
  const scroll = window.scrollY;
  if (!S.ws) {
    $('#view').innerHTML = `<div class="empty"><h2>Create your first workspace</h2><p>Connect a product to start generating creatives.</p><button class="btn signal" data-action="new-workspace">+ New workspace</button></div>`;
    return;
  }
  if (!S.campaign && r !== 'workspace') {
    $('#view').innerHTML = `<h1 class="page">${esc(S.ws.name)}</h1><p class="page-sub">No campaign yet.</p><div class="empty"><p>Campaigns hold creatives, the schedule and the launch checklist.</p><button class="btn signal" data-action="new-campaign">+ New campaign</button></div>`;
    return;
  }
  $('#view').innerHTML = VIEWS[r]();
  window.scrollTo(0, scroll);
}

// ------------------------------------------------------------------ dashboard
function viewDashboard() {
  const p = S.progress;
  const c = p.campaign;
  const st = p.assets.states;
  const next = p.nextScheduled[0];
  const order = ['DRAFT', 'NEEDS_REVIEW', 'NEEDS_REVISION', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED'];
  const launchTxt = p.launchInDays > 0 ? `Launch in ${p.launchInDays} day${p.launchInDays === 1 ? '' : 's'}` : p.launchInDays === 0 ? 'Launch day' : `Launched ${-p.launchInDays} days ago`;
  const conv = p.metrics.conversions.reduce((s, r) => s + r.signups, 0);
  return `
  <div class="spread"><div><div class="eyebrow">${esc(launchTxt)} · ${fmtDate(c.launch_date)}</div><h1 class="page">${esc(c.name)}</h1><p class="page-sub">${esc(c.goal || '')}</p></div>
  <div class="row"><a class="btn ghost" href="#/studio">Open studio</a><a class="btn" href="#/review">Review ${st.NEEDS_REVIEW ? `(${st.NEEDS_REVIEW})` : ''}</a></div></div>
  <div class="kpis">
    <div class="card kpi"><div class="ring" style="--p:${p.tasks.pct}"><div>${p.tasks.pct}%</div></div><div><div class="eyebrow">Campaign progress</div><div class="big">${p.tasks.done}<span class="muted" style="font-size:18px"> / ${p.tasks.total}</span></div><div class="lbl">tasks done · ${p.tasks.remaining} remaining${p.tasks.overdue.length ? ` · <b style="color:var(--bad)">${p.tasks.overdue.length} overdue</b>` : ''}</div></div></div>
    <div class="card"><div class="eyebrow">Publish readiness</div><div class="kpi"><div class="big">${p.assets.readinessPct}%</div><div class="lbl">${p.assets.ready} of ${p.assets.total} creatives approved, scheduled or live</div></div>
      <div class="stackbar">${order.map((s) => (st[s] ? `<i title="${STATE_LABEL[s]}: ${st[s]}" style="width:${(st[s] / p.assets.total) * 100}%;background:${STATE_COLOR[s]}"></i>` : '')).join('')}</div></div>
    <div class="card"><div class="eyebrow">Next publish</div>${next ? `<div class="big" style="font-size:22px;margin-top:6px">${esc(rel(next.run_at))}</div><div class="lbl">${esc(ch(next.channel).label)} · ${esc(next.title)} ${next.status === 'manual_required' ? '<span class="badge b-kit">manual</span>' : ''}</div>` : '<div class="lbl" style="margin-top:8px">Nothing scheduled</div>'}</div>
    <div class="card"><div class="eyebrow">Signups attributed</div><div class="kpi"><div class="big">${num(p.metrics.totals.signups)}</div><div class="lbl">${num(p.metrics.totals.clicks)} clicks · CTR ${pct(p.metrics.ctr)}<br>${conv} via conversion webhook</div></div></div>
  </div>
  <div class="pipeline">${order.map((s) => `<a class="pipe s-${s}" href="#/${['DRAFT', 'NEEDS_REVISION'].includes(s) ? 'studio' : 'review'}"><div class="n">${st[s]}</div><div class="t">${STATE_LABEL[s]}</div></a>`).join('')}</div>
  ${p.iterationPrompt ? `<div class="callout" style="margin-bottom:18px"><div><b>Post-publish loop:</b> “${esc(p.iterationPrompt.title)}” leads with ${num(p.iterationPrompt.clicks)} clicks and ${num(p.iterationPrompt.signups)} signups (CTR ${pct(p.iterationPrompt.ctr)}). Generate a follow-up variation while it’s hot.</div><button class="btn signal" data-action="iterate" data-id="${p.iterationPrompt.assetId}">Generate variation</button></div>` : ''}
  <div class="grid2">
    <div class="stack">
      <div class="card"><div class="card-head"><h2>Upcoming & overdue</h2><a class="link" href="#/timeline">Full timeline →</a></div>
        <div class="list">${[...p.tasks.overdue, ...p.tasks.upcoming].slice(0, 8).map(taskRow).join('') || '<div class="muted">All caught up.</div>'}</div></div>
      <div class="card"><div class="card-head"><h2>Channel readiness</h2><a class="link" href="#/workspace">Rules →</a></div>
        <table class="t"><thead><tr><th>Channel</th><th>Route</th><th>Auto-post</th><th class="num">Ready</th><th class="num">Live</th></tr></thead><tbody>
        ${p.channels.map((c) => `<tr><td><b>${esc(c.label)}</b></td><td>${modeBadge(c)}</td><td>${c.mode === 'api' ? (c.auto_publish ? 'On' : '<span class="muted">Off</span>') : '<span class="muted">—</span>'}</td><td class="num">${c.ready}/${c.total}</td><td class="num">${c.published}</td></tr>`).join('')}
        </tbody></table></div>
    </div>
    <div class="stack">
      <div class="card"><div class="card-head"><h2>Category progress</h2></div>
        ${Object.entries(p.tasks.byCategory).map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><div class="bar ${v.done === v.total && v.total ? 'ok' : 'signal'}"><i style="width:${v.total ? (v.done / v.total) * 100 : 0}%"></i></div><span class="mono">${v.done}/${v.total}</span></div>`).join('')}</div>
      <div class="card"><div class="card-head"><h2>Publish log</h2><span class="muted small">scheduler ${S.health.publishMode} mode</span></div>
        <div class="list feed">${p.activity.map((a) => `<div class="li"><span class="lvl ${a.level}"></span><div class="grow"><div>${esc(isoPretty(a.msg))}</div><div class="muted small">${esc(a.asset)} · ${esc(rel(a.at))}</div></div></div>`).join('') || '<div class="muted">No publish activity yet.</div>'}</div></div>
    </div>
  </div>`;
}
function taskRow(t) {
  const over = !t.done && t.due_date < todayIso();
  return `<div class="li ${t.done ? 'done' : ''}"><label class="check"><input type="checkbox" data-action="toggle-task" data-id="${t.id}" ${t.done ? 'checked' : ''}></label>
    <div class="grow"><div class="title">${esc(t.title)}</div><div class="row small"><span class="cat ${CAT_CLASS(t.category)}">${esc(t.category)}</span><span class="role">${esc(t.role || '')}</span>${t.asset_id ? `<button class="link small" data-action="open-asset" data-id="${t.asset_id}">open creative</button>` : ''}</div></div>
    <span class="due ${over ? 'over' : ''}">${over ? 'overdue · ' : ''}${fmtDate(t.due_date)}</span></div>`;
}

// ------------------------------------------------------------------ workspace / source connector
function viewWorkspace() {
  const w = S.ws;
  const sm = w.source_meta || {};
  const L = w.locale || {};
  const opt = (list, v) => list.map(([val, lbl]) => `<option value="${val}" ${val === v ? 'selected' : ''}>${lbl}</option>`).join('');
  return `
  <h1 class="page">Product source</h1><p class="page-sub">Everything LaunchLoop generates comes from these facts — nothing is invented. Import from your site, then edit freely.</p>
  <div class="grid2">
  <div class="stack">
    <div class="card"><div class="card-head"><h2>1 · Connect a source</h2>${sm.importedAt ? `<span class="muted small">last import ${esc(rel(sm.importedAt))} · ${esc(sm.generator || '')}</span>` : ''}</div>
      <form data-form="ingest-url" class="row" style="flex-wrap:nowrap"><input type="url" name="url" placeholder="https://yourproduct.com" value="${esc(w.website_url || '')}" required><button class="btn">Import website</button></form>
      <p class="muted small" style="margin:8px 0 14px">Reads only the page you enter plus up to 3 feature/pricing pages from its sitemap. Respects robots.txt, blocks private addresses, never logs in or scrapes social platforms.</p>
      <details><summary class="link">Or paste product details manually</summary>
        <form data-form="ingest-text" style="margin-top:10px"><textarea name="text" rows="6" placeholder="Paste your landing page copy, feature list, pricing, changelog…"></textarea><div class="row" style="margin-top:8px"><button class="btn">Analyze pasted text</button></div></form></details>
      ${sm.pages?.length ? `<div style="margin-top:14px" class="small"><div class="eyebrow">Imported pages</div>${sm.pages.map((pg) => `<div class="mono">${esc(pg.url)}</div>`).join('')}${(sm.notes || []).map((n) => `<div class="muted">${esc(n)}</div>`).join('')}</div>` : ''}
    </div>
    <form class="card" data-form="workspace">
      <div class="card-head"><h2>2 · Product facts</h2><button class="btn">Save workspace</button></div>
      <div class="form-grid">
        <label class="f">Product name<input type="text" name="name" value="${esc(w.name)}" required></label>
        <label class="f">Tagline<input type="text" name="tagline" value="${esc(w.tagline)}"></label>
        <label class="f full">Description<textarea name="description" rows="3">${esc(w.description)}</textarea></label>
        <label class="f">Target audience<input type="text" name="audience" value="${esc(w.audience)}"></label>
        <label class="f">Pricing <span class="hint">e.g. 6 or "$6 / user / mo"</span><input type="text" name="pricing" value="${esc(w.pricing)}"></label>
        <label class="f">Launch offer<input type="text" name="offer" value="${esc(w.offer)}"></label>
        <label class="f">Referral / share mechanic<input type="text" name="referral_mechanics" value="${esc(w.referral_mechanics)}" placeholder="invite a teammate, both get a month free"></label>
      </div>
      <h3 style="margin-top:16px">Features <span class="muted small">(name → outcome-focused benefit)</span></h3>
      <div id="features">${(w.features || []).map(featRow).join('')}</div>
      <button type="button" class="btn ghost sm" data-action="add-feature">+ Feature</button>
      <div class="form-grid" style="margin-top:14px">
        <label class="f">Value props <span class="hint">one per line</span><textarea name="value_props" rows="4">${esc((w.value_props || []).join('\n'))}</textarea></label>
        <label class="f">Pain points <span class="hint">one per line, as activities</span><textarea name="pain_points" rows="4">${esc((w.pain_points || []).join('\n'))}</textarea></label>
      </div>
      <h3 style="margin-top:18px">3 · Brand kit</h3>
      <div class="form-grid">
        <div class="row">${['primary', 'secondary', 'accent'].map((k) => `<label class="f">${k}<input type="color" name="color_${k}" value="${esc(w.brand?.colors?.[k] || '#000000')}"></label>`).join('')}</div>
        <div class="row"><label class="f" style="flex:1">Heading font<input type="text" name="font_heading" value="${esc(w.brand?.fonts?.heading || '')}"></label><label class="f" style="flex:1">Body font<input type="text" name="font_body" value="${esc(w.brand?.fonts?.body || '')}"></label></div>
        <div><div class="f" style="margin-bottom:6px;font-size:12px;font-weight:600;color:var(--ink-2)">Logo</div><div class="row">${w.brand?.logo ? `<span class="logo-pv"><img src="${esc(w.brand.logo)}" alt="logo"></span><button type="button" class="btn xs ghost" data-action="remove-logo">Remove</button>` : '<span class="muted small">No logo — wordmark is used</span>'}<label class="btn ghost sm">Upload<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" data-upload="logo" hidden></label></div></div>
        <div><div style="margin-bottom:6px;font-size:12px;font-weight:600;color:var(--ink-2)">Product screenshots <span class="muted">(used in flyers & posts)</span></div><div class="thumbs">${(w.screenshots || []).map((s, i) => `<figure><img src="${esc(s.dataUrl)}" alt=""><button type="button" data-action="remove-shot" data-i="${i}">×</button></figure>`).join('')}${(w.screenshots || []).length < 4 ? `<label class="btn ghost sm" style="height:80px;align-items:center">+ Add<input type="file" accept="image/*" data-upload="screenshot" hidden></label>` : ''}</div></div>
      </div>
      <h3 style="margin-top:18px">4 · Audience & locale</h3>
      <div class="form-grid">
        <label class="f">Language<select name="language">${opt([['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese']], L.language)}</select></label>
        <label class="f">Region<select name="region">${opt([['US', 'United States'], ['GB', 'United Kingdom'], ['IE', 'Ireland'], ['IS', 'Iceland'], ['DE', 'Germany'], ['FR', 'France'], ['ES', 'Spain'], ['BR', 'Brazil'], ['IN', 'India'], ['AU', 'Australia']], L.region)}</select></label>
        <label class="f">Currency<select name="currency">${opt([['USD', 'USD $'], ['EUR', 'EUR €'], ['GBP', 'GBP £'], ['ISK', 'ISK kr'], ['INR', 'INR ₹'], ['BRL', 'BRL R$'], ['AUD', 'AUD $']], L.currency)}</select></label>
        <label class="f">Date format<select name="dateFormat">${opt([['MMM D, YYYY', 'Nov 21, 2026'], ['DD/MM/YYYY', '21/11/2026'], ['MM/DD/YYYY', '11/21/2026'], ['YYYY-MM-DD', '2026-11-21']], L.dateFormat)}</select></label>
        <label class="f">Regional tone<select name="tone">${opt([['friendly', 'Friendly'], ['direct', 'Direct'], ['formal', 'Formal'], ['playful', 'Playful']], L.tone)}</select></label>
        <div class="f">Preview<div class="muted">${esc(fmtDate(new Date().toISOString()))} · ${esc(w.pricing && /^\d+(\.\d+)?$/.test(w.pricing) ? money(w.pricing) : w.pricing || money(9))}</div></div>
      </div>
    </form>
  </div>
  <div class="stack">
    <div class="card"><div class="card-head"><h2>Channels & auto-publish rules</h2></div>
      <p class="muted small" style="margin-top:-6px">API channels post approved, scheduled items automatically via official APIs. Share Kit channels get pre-sized media, captions and a checklist for one-tap manual posting.</p>
      <table class="t"><tbody>${S.channels.map(channelRow).join('')}</tbody></table></div>
    <div class="card"><div class="card-head"><h2>Inbound webhooks</h2><button class="btn ghost xs" data-action="rotate-secret">Rotate secret</button></div>
      <div class="small stack" style="gap:10px">
        <div><div class="eyebrow">Workspace ID</div><div class="copybox"><input type="text" readonly value="${esc(w.id)}"><button class="btn ghost sm" data-copy="${esc(w.id)}">Copy</button></div></div>
        <div><div class="eyebrow">Signing secret</div><div class="copybox"><input type="password" readonly value="${esc(w.webhook_secret)}" id="secretField"><button class="btn ghost sm" data-action="reveal">Show</button><button class="btn ghost sm" data-copy="${esc(w.webhook_secret)}">Copy</button></div></div>
        <div><b>POST /api/webhooks/product-update</b> — new feature/release → new campaign with DRAFT creatives + tasks.<br><b>POST /api/webhooks/conversion</b> — signup/referral with utm_* → attributed to the creative.</div>
        <div class="code">${esc(`# Header: X-LaunchLoop-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
npm run webhook -- conversion --url ${S.config.publicBaseUrl} \\
  --workspace ${w.id} --secret <secret> \\
  --campaign ${S.campaign?.utm_campaign || 'your_campaign'} --content reel-<assetIdHex>-v1`)}</div>
        <button class="link" data-action="webhook-events">View recent webhook events →</button>
      </div></div>
  </div></div>`;
}
const featRow = (f = {}) => `<div class="feat-row"><input type="text" data-feat="name" placeholder="Feature" value="${esc(f.name)}"><input type="text" data-feat="benefit" placeholder="Benefit" value="${esc(f.benefit)}"><button type="button" class="btn ghost sm" data-action="remove-feature">×</button></div>`;
function channelRow(c) {
  const def = ch(c.channel);
  return `<tr><td><b>${esc(def.label)}</b><div class="muted small" title="${esc(def.requirements)}">${esc(def.api || 'No public publishing API')}</div></td>
    <td><select data-action="channel-mode" data-id="${c.id}" style="width:auto">${def.apiAvailable ? `<option value="api" ${c.mode === 'api' ? 'selected' : ''}>API</option>` : ''}<option value="share_kit" ${c.mode === 'share_kit' ? 'selected' : ''}>Share Kit</option></select></td>
    <td><label class="row small" title="Auto-publish approved items when their time comes"><span class="toggle"><input type="checkbox" data-action="channel-auto" data-id="${c.id}" ${c.auto_publish ? 'checked' : ''} ${c.mode !== 'api' ? 'disabled' : ''}><span></span></span>auto</label></td>
    <td><span class="badge ${c.status === 'connected' ? 'b-api' : c.status === 'mock' ? 'b-sim' : 'b-mute'}">${esc(c.status)}</span></td></tr>`;
}

// ------------------------------------------------------------------ studio
function viewStudio() {
  const fmts = ['all', 'reel', 'video', 'flyer', 'post', 'carousel'];
  const states = ['all', 'DRAFT', 'NEEDS_REVIEW', 'NEEDS_REVISION', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED'];
  const list = S.assets.filter((a) => (S.ui.studioFormat === 'all' || a.format === S.ui.studioFormat) && (S.ui.studioState === 'all' || a.state === S.ui.studioState));
  const drafts = S.assets.filter((a) => a.state === 'DRAFT').length;
  return `
  <div class="spread"><div><h1 class="page">Creative studio</h1><p class="page-sub">Reels, short videos, flyers, posts and carousels — sized per channel, scored for hook & virality.</p></div>
  ${drafts ? `<button class="btn" data-action="submit-drafts">Submit ${drafts} draft${drafts > 1 ? 's' : ''} for review</button>` : ''}</div>
  <form class="card" data-form="generate" style="margin-bottom:18px">
    <div class="card-head"><h2>Generate campaign package</h2><span class="muted small">Approved, scheduled and published creatives are never overwritten.</span></div>
    <div class="stack" style="gap:10px">
      <div class="row"><span class="eyebrow" style="width:70px">Channels</span><div class="chips">${S.campaign.channels.map((c) => `<label class="chip-check"><input type="checkbox" name="channels" value="${c}" checked>${esc(ch(c).label)}</label>`).join('')}</div></div>
      <div class="row"><span class="eyebrow" style="width:70px">Formats</span><div class="chips">${['reel', 'video', 'flyer', 'post', 'carousel'].map((f) => `<label class="chip-check"><input type="checkbox" name="formats" value="${f}" checked>${fmtLabel(f)}</label>`).join('')}</div></div>
      <div class="row" style="flex-wrap:nowrap"><input type="text" name="instruction" placeholder="Optional direction, e.g. “lean on the before/after angle, mention the launch offer”"><label class="check small" style="white-space:nowrap"><input type="checkbox" name="includeLocked"> also add new variants next to approved items</label><button class="btn signal">Generate</button></div>
    </div>
  </form>
  <div class="spread" style="margin-bottom:12px"><div class="chips">${fmts.map((f) => `<button class="chip ${S.ui.studioFormat === f ? 'on' : ''}" data-action="filter-format" data-v="${f}">${f === 'all' ? 'All formats' : fmtLabel(f)}</button>`).join('')}</div>
  <div class="chips">${states.map((s) => `<button class="chip ${S.ui.studioState === s ? 'on' : ''}" data-action="filter-state" data-v="${s}">${s === 'all' ? 'Any state' : STATE_LABEL[s]}</button>`).join('')}</div></div>
  ${list.length ? `<div class="asset-grid">${list.map(assetCard).join('')}</div>` : '<div class="empty">No creatives match. Generate a package above.</div>'}`;
}
function assetCard(a) {
  const n = a.format === 'carousel' ? ` · ${a.content.slides?.length || 0} slides` : a.content.durationSec ? ` · ${a.content.durationSec}s` : '';
  return `<div class="asset">
    <div class="thumb" data-action="open-asset" data-id="${a.id}"><img loading="lazy" src="${mediaUrl(a)}" alt=""><span class="fmt">${esc(ch(a.channel).label)} · ${esc(fmtLabel(a.format))} · ${esc(a.aspect_ratio)}${n}</span></div>
    <div class="body"><div class="name">${esc(a.title)}</div><div class="meta">${badge(a.state)}${scorePill(a.score)}</div>
    ${a.parent_id ? `<div class="muted small">↳ variation · v${a.version}</div>` : `<div class="muted small">v${a.version} · ${esc((a.generator || '').split(' ')[0])}</div>`}</div>
    <div class="actions"><button class="btn sm" data-action="open-asset" data-id="${a.id}">Open</button>
    ${a.state === 'DRAFT' ? `<button class="btn ghost sm" data-action="transition" data-to="NEEDS_REVIEW" data-id="${a.id}">Submit</button>` : ''}
    ${a.state !== 'PUBLISHED' ? `<button class="btn ghost sm" data-action="regenerate" data-id="${a.id}" title="${['APPROVED', 'SCHEDULED', 'FAILED'].includes(a.state) ? 'Creates a new draft variant; this one stays untouched' : 'Regenerate in place'}">↻ ${['APPROVED', 'SCHEDULED', 'FAILED'].includes(a.state) ? 'Variant' : 'Regenerate'}</button>` : `<button class="btn ghost sm" data-action="regenerate" data-id="${a.id}">↻ Variant</button>`}</div>
  </div>`;
}

// ------------------------------------------------------------------ review queue
function viewReview() {
  const by = (s) => S.assets.filter((a) => a.state === s);
  const lane = (title, sub, items, renderer) => `<div class="lane"><div class="lane-head"><h2>${title}</h2><span class="badge b-mute">${items.length}</span><span class="muted small">${sub}</span></div>${items.length ? items.map(renderer).join('') : '<div class="muted small" style="padding:4px 0 10px">Nothing here.</div>'}</div>`;
  const nextHour = new Date(Math.ceil(Date.now() / 3600000) * 3600000);
  const mini = (a) => `<div class="mini" data-action="open-asset" data-id="${a.id}"><img src="${mediaUrl(a)}" alt=""></div>`;
  const head = (a) => `<div class="row" style="gap:8px"><b>${esc(a.title)}</b>${badge(a.state)}${scorePill(a.score)}</div><div class="cap" style="margin-top:4px">${esc(a.caption)}</div>`;
  const drafts = by('DRAFT').length;
  return `
  <div class="spread"><div><h1 class="page">Approval queue</h1><p class="page-sub">Only <b>Approved → Scheduled</b> items can auto-publish. Editing an approved item sends it back here.</p></div>${drafts ? `<button class="btn ghost" data-action="submit-drafts">Submit ${drafts} draft${drafts > 1 ? 's' : ''}</button>` : ''}</div>
  <div class="card" style="margin-bottom:22px"><div class="card-head" style="margin-bottom:8px"><h2>Auto-publish rules</h2><span class="muted small">per channel · applies when a scheduled item comes due</span></div>
    <div class="row" style="gap:18px">${S.campaign.channels.map((k) => {
      const c = conn(k);
      return `<label class="row small"><span class="toggle"><input type="checkbox" data-action="channel-auto" data-id="${c?.id}" ${c?.auto_publish ? 'checked' : ''} ${c?.mode !== 'api' ? 'disabled' : ''}><span></span></span><b>${esc(ch(k).label)}</b>${c?.mode !== 'api' ? '<span class="badge b-kit">Share Kit</span>' : ''}</label>`;
    }).join('')}</div></div>
  ${lane('Needs review', 'approve or request changes', by('NEEDS_REVIEW'), (a) => `<div class="rev">${mini(a)}<div>${head(a)}</div><div class="ctrl"><div class="row"><button class="btn ok sm" data-action="transition" data-to="APPROVED" data-id="${a.id}">Approve</button><button class="btn ghost sm" data-action="request-changes" data-id="${a.id}">Request changes</button></div><button class="link small" data-action="open-asset" data-id="${a.id}">Open editor</button></div></div>`)}
  ${lane('Approved — set a publish time', 'scheduling queues a job for the worker', by('APPROVED'), (a) => {
    const c = conn(a.channel);
    const auto = c?.mode === 'api';
    return `<div class="rev">${mini(a)}<div>${head(a)}</div><div class="ctrl"><input type="datetime-local" id="when-${a.id}" value="${toLocalInput(nextHour)}" style="width:210px"><label class="row small"><span class="toggle"><input type="checkbox" id="auto-${a.id}" ${a.auto_publish && auto ? 'checked' : ''} ${auto ? '' : 'disabled'}><span></span></span>${auto ? 'auto-publish via API' : 'Share Kit — manual post'}</label><div class="row"><button class="btn sm" data-action="schedule" data-id="${a.id}">Schedule</button><button class="btn ghost sm" data-action="schedule-now" data-id="${a.id}">Publish now</button></div></div></div>`;
  })}
  ${lane('Scheduled', 'the scheduler transitions these when due', by('SCHEDULED'), (a) => {
    const c = conn(a.channel);
    const willAuto = a.auto_publish && c?.mode === 'api' && c?.auto_publish;
    const due = new Date(a.scheduled_at) <= new Date();
    return `<div class="rev">${mini(a)}<div>${head(a)}<div class="row small" style="margin-top:6px"><span class="mono">${fmtDate(a.scheduled_at, { time: true })}</span><span class="muted">(${esc(rel(a.scheduled_at))})</span>${willAuto ? '<span class="badge b-api">auto-publish</span>' : `<span class="badge b-kit">${due ? 'post now via Share Kit' : 'manual · Share Kit'}</span>`}</div></div>
      <div class="ctrl">${!willAuto ? `<button class="btn signal sm" data-action="share-kit" data-id="${a.id}">Open Share Kit</button>` : ''}<div class="row"><button class="btn ghost sm" data-action="unschedule" data-id="${a.id}">Unschedule</button></div></div></div>`;
  })}
  ${lane('Failed', 'retry or fix and re-approve', by('FAILED'), (a) => `<div class="rev">${mini(a)}<div>${head(a)}<div class="err" style="margin-top:6px">${esc(a.error || 'Unknown error')}</div></div><div class="ctrl"><button class="btn sm" data-action="retry" data-id="${a.id}">Retry now</button><button class="btn ghost sm" data-action="share-kit" data-id="${a.id}">Share Kit instead</button><button class="link small" data-action="open-asset" data-id="${a.id}">Edit</button></div></div>`)}
  ${lane('Needs revision', 'edit or regenerate, then resubmit', by('NEEDS_REVISION'), (a) => `<div class="rev">${mini(a)}<div>${head(a)}${a.review_note ? `<div class="note" style="margin-top:6px">✎ ${esc(a.review_note)}</div>` : ''}</div><div class="ctrl"><button class="btn sm" data-action="open-asset" data-id="${a.id}">Edit</button><button class="btn ghost sm" data-action="transition" data-to="NEEDS_REVIEW" data-id="${a.id}">Resubmit</button></div></div>`)}
  ${lane('Published', 'live — see Analytics for performance', by('PUBLISHED'), (a) => `<div class="rev">${mini(a)}<div>${head(a)}<div class="row small" style="margin-top:6px"><span class="mono">${fmtDate(a.published_at, { time: true })}</span>${a.external_url ? `<a class="link" href="${esc(a.external_url)}" target="_blank" rel="noopener">view post ↗</a>` : ''}</div></div><div class="ctrl"><button class="btn ghost sm" data-action="iterate" data-id="${a.id}">Generate variation</button></div></div>`)}`;
}

// ------------------------------------------------------------------ timeline & tasks
function viewTimeline() {
  const p = S.progress;
  const cats = ['all', ...S.config.taskCategories];
  const tasks = S.tasks.filter((t) => (S.ui.taskCat === 'all' || t.category === S.ui.taskCat) && (!S.ui.hideDone || !t.done));
  const launch = S.campaign.launch_date;
  let body;
  if (S.ui.taskView === 'list') {
    body = S.config.taskCategories.filter((c) => S.ui.taskCat === 'all' || c === S.ui.taskCat).map((c) => {
      const items = tasks.filter((t) => t.category === c);
      const bc = p.tasks.byCategory[c];
      return `<div class="card"><div class="card-head"><h2><span class="cat ${CAT_CLASS(c)}">${esc(c)}</span></h2><span class="mono">${bc.done}/${bc.total}</span></div><div class="list">${items.map(taskRow).join('') || '<div class="muted small">No tasks.</div>'}</div></div>`;
    }).join('');
    body = `<div class="stack">${body}</div>`;
  } else {
    const days = new Map();
    const add = (d, item) => (days.has(d) ? days.get(d) : days.set(d, []).get(d)).push(item);
    tasks.forEach((t) => add(t.due_date, { kind: 'task', t }));
    S.assets.filter((a) => a.scheduled_at || a.published_at).forEach((a) => add((a.published_at || a.scheduled_at).slice(0, 10), { kind: 'asset', a }));
    add(todayIso(), { kind: 'marker' });
    add(launch, { kind: 'marker' });
    const sorted = [...days.keys()].sort();
    body = `<div class="card tl">${sorted.map((d) => {
      const items = days.get(d).filter((i) => i.kind !== 'marker');
      const isToday = d === todayIso();
      const isLaunch = d === launch;
      const dd = new Date(d + 'T12:00:00Z');
      const off = Math.round((dd - new Date(launch + 'T12:00:00Z')) / 86400000);
      return `<div class="tl-day ${isToday ? 'today' : ''} ${isLaunch ? 'launch' : ''}"><div class="tl-date"><b>${fmtDate(d)}</b>${isLaunch ? '🚀 launch day' : `L${off >= 0 ? '+' : ''}${off}`}${isToday ? ' · today' : ''}</div><div class="tl-items">
        ${items.filter((i) => i.kind === 'asset').map(({ a }) => `<div><span class="tl-asset s-${a.state}" data-action="open-asset" data-id="${a.id}">${a.state === 'PUBLISHED' ? '●' : '◷'} ${esc(ch(a.channel).label)} · ${esc(fmtLabel(a.format))} — ${STATE_LABEL[a.state]} ${a.state !== 'PUBLISHED' ? new Date(a.scheduled_at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : ''}</span></div>`).join('')}
        ${items.filter((i) => i.kind === 'task').map(({ t }) => `<div class="tl-task ${t.done ? 'done' : ''}"><label class="check"><input type="checkbox" data-action="toggle-task" data-id="${t.id}" ${t.done ? 'checked' : ''}></label><span class="t-title" style="flex:1">${esc(t.title)}</span><span class="cat ${CAT_CLASS(t.category)}">${esc(t.category)}</span><span class="role">${esc(t.role || '')}</span>${t.source !== 'auto' ? `<span class="badge b-mute">${esc(t.source.replace('_', ' '))}</span>` : ''}<button class="x" style="font-size:16px" title="Delete task" data-action="delete-task" data-id="${t.id}">×</button></div>`).join('')}
        ${!items.length ? '<div class="muted small">—</div>' : ''}
      </div></div>`;
    }).join('')}</div>`;
  }
  return `
  <h1 class="page">Timeline & tasks</h1><p class="page-sub">Auto-generated launch checklist around ${fmtDate(launch)}. The scheduler and post-publish loop add tasks here as things happen.</p>
  <div class="kpis" style="grid-template-columns:1.2fr 2fr">
    <div class="card kpi"><div class="ring" style="--p:${p.tasks.pct}"><div>${p.tasks.pct}%</div></div><div><div class="big">${p.tasks.done}<span class="muted" style="font-size:18px"> done</span></div><div class="lbl">${p.tasks.remaining} remaining · ${p.tasks.overdue.length} overdue · publish readiness ${p.assets.readinessPct}%</div></div></div>
    <div class="card">${Object.entries(p.tasks.byCategory).map(([k, v]) => `<div class="hbar"><span>${esc(k)}</span><div class="bar ${v.done === v.total && v.total ? 'ok' : 'signal'}"><i style="width:${v.total ? (v.done / v.total) * 100 : 0}%"></i></div><span class="mono">${v.done}/${v.total}</span></div>`).join('')}</div>
  </div>
  <div class="spread" style="margin-bottom:12px">
    <div class="chips">${cats.map((c) => `<button class="chip ${S.ui.taskCat === c ? 'on' : ''}" data-action="filter-cat" data-v="${esc(c)}">${c === 'all' ? 'All' : esc(c)}</button>`).join('')}</div>
    <div class="row"><label class="check small"><input type="checkbox" data-action="hide-done" ${S.ui.hideDone ? 'checked' : ''}> hide done</label><div class="chips"><button class="chip ${S.ui.taskView === 'timeline' ? 'on' : ''}" data-action="task-view" data-v="timeline">Timeline</button><button class="chip ${S.ui.taskView === 'list' ? 'on' : ''}" data-action="task-view" data-v="list">By category</button></div></div>
  </div>
  <form class="card row" data-form="add-task" style="margin-bottom:14px;flex-wrap:nowrap">
    <input type="text" name="title" placeholder="Add a task…" required>
    <select name="category" style="width:200px">${S.config.taskCategories.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
    <input type="text" name="role" placeholder="Role" style="width:140px">
    <input type="date" name="due_date" value="${todayIso()}" style="width:160px"><button class="btn">Add</button></form>
  ${body}`;
}

// ------------------------------------------------------------------ analytics
function viewAnalytics() {
  const p = S.progress;
  const t = p.metrics.totals;
  const rows = p.metrics.perAsset;
  const maxConv = Math.max(1, ...p.metrics.conversions.map((c) => c.signups));
  const srcBadge = (s) => (s || '').split(',').filter(Boolean).map((x) => `<span class="badge ${x === 'simulated' ? 'b-sim' : x === 'webhook' ? 'b-api' : 'b-mute'}">${esc(x)}</span>`).join(' ');
  return `
  <h1 class="page">Analytics & iteration loop</h1><p class="page-sub">Performance per creative and channel. Simulated numbers are labelled — connect platform insights or enter real numbers to replace them.</p>
  <div class="kpis" style="grid-template-columns:repeat(5,1fr)">
    ${[['Impressions', num(t.impressions)], ['Clicks', num(t.clicks)], ['CTR', pct(p.metrics.ctr)], ['Shares', num(t.shares)], ['Signups', num(t.signups)]].map(([l, v]) => `<div class="card"><div class="eyebrow">${l}</div><div class="kpi"><div class="big">${v}</div></div></div>`).join('')}
  </div>
  ${p.iterationPrompt ? `<div class="callout" style="margin-bottom:18px"><div><b>Top performer:</b> “${esc(p.iterationPrompt.title)}” — ${num(p.iterationPrompt.clicks)} clicks, ${num(p.iterationPrompt.signups)} signups. A follow-up variation keeps the winning format and tests a new hook angle.</div><button class="btn signal" data-action="iterate" data-id="${p.iterationPrompt.assetId}">Generate follow-up variation</button></div>` : '<div class="callout info" style="margin-bottom:18px"><div>Once creatives are published and collect metrics, the top performer appears here with a one-click follow-up variation.</div></div>'}
  <div class="card flush" style="margin-bottom:18px"><table class="t"><thead><tr><th>Creative</th><th>Channel</th><th class="num">Impr.</th><th class="num">Clicks</th><th class="num">CTR</th><th class="num">Shares</th><th class="num">Signups</th><th class="num">CVR</th><th>Source</th><th></th></tr></thead><tbody>
  ${rows.map((r, i) => `<tr><td>${i === 0 && r.impressions ? '🏆 ' : ''}<button class="link" data-action="open-asset" data-id="${r.id}">${esc(r.title)}</button>${r.parent_id ? ' <span class="badge b-mute">variation</span>' : ''}</td><td>${esc(ch(r.channel).label)}</td><td class="num">${num(r.impressions)}</td><td class="num">${num(r.clicks)}</td><td class="num">${pct(r.ctr)}</td><td class="num">${num(r.shares)}</td><td class="num"><b>${num(r.signups)}</b></td><td class="num">${pct(r.cvr)}</td><td>${srcBadge(r.sources)}</td><td><div class="row" style="flex-wrap:nowrap"><button class="btn ghost xs" data-action="add-metrics" data-id="${r.id}">+ Metrics</button><button class="btn ghost xs" data-action="iterate" data-id="${r.id}">Iterate</button></div></td></tr>`).join('') || '<tr><td colspan="10" class="muted" style="text-align:center;padding:30px">No published creatives yet.</td></tr>'}
  </tbody></table></div>
  <div class="grid2 even">
    <div class="card"><div class="card-head"><h2>Conversions by channel</h2><span class="muted small">from POST /api/webhooks/conversion</span></div>
      ${p.metrics.conversions.map((c) => `<div class="hbar"><span>${esc(ch(c.channel).label || c.channel)}</span><div class="bar"><i style="width:${(c.signups / maxConv) * 100}%"></i></div><span class="mono">${c.signups}</span></div>`).join('') || '<div class="muted small">No webhook conversions yet. Send one with <span class="mono">npm run webhook -- conversion …</span></div>'}</div>
    <form class="card" data-form="utm"><div class="card-head"><h2>UTM & attribution link builder</h2></div>
      <div class="form-grid">
        <label class="f full">Destination URL<input type="url" name="url" value="${esc(S.campaign.base_url || S.ws.website_url || '')}" required></label>
        <label class="f">utm_source<select name="source">${S.campaign.channels.map((c) => `<option value="${c}">${c}</option>`).join('')}<option value="newsletter">newsletter</option><option value="community">community</option></select></label>
        <label class="f">utm_medium<input type="text" name="medium" value="social"></label>
        <label class="f">utm_campaign<input type="text" name="campaign" value="${esc(S.campaign.utm_campaign)}"></label>
        <label class="f">utm_content<input type="text" name="content" placeholder="reel-hook-a"></label>
      </div>
      <div class="row" style="margin-top:10px"><button class="btn">Build link</button></div>
      <div class="copybox" style="margin-top:10px"><input type="text" id="utmOut" readonly placeholder="Tagged link appears here"><button type="button" class="btn ghost sm" data-action="copy-utm">Copy</button></div>
      <p class="muted small">Every generated creative already carries its own link: <span class="mono">utm_content=&lt;format&gt;-&lt;assetId&gt;-v&lt;version&gt;</span>, which the conversion webhook maps back to the exact creative.</p></form>
  </div>`;
}

// ------------------------------------------------------------------ modals
function openModal(html, { narrow = false } = {}) {
  $('#modal-root').innerHTML = `<div class="overlay" data-action="close-overlay"><div class="modal ${narrow ? 'narrow' : ''}">${html}</div></div>`;
}
function closeModal() {
  $('#modal-root').innerHTML = '';
}
const modalHead = (title, extra = '') => `<div class="modal-head"><div class="row"><h2>${title}</h2>${extra}</div><button class="x" data-action="close">×</button></div>`;

async function openAsset(assetId, slide = 0) {
  const a = await api('GET', `/api/assets/${assetId}`);
  const c = a.content || {};
  const limit = ch(a.channel).captionLimit;
  const locked = a.state === 'PUBLISHED';
  const lockNote = ['APPROVED', 'SCHEDULED'].includes(a.state) ? '<div class="note">Editing content will send this back to <b>Needs review</b> and cancel any scheduled job.</div>' : '';
  const sc = a.score || {};
  const transitions = (a.allowed_next || []).filter((s) => !['SCHEDULED', 'PUBLISHED', 'FAILED'].includes(s));
  const trLabel = { NEEDS_REVIEW: 'Submit for review', APPROVED: 'Approve', NEEDS_REVISION: 'Request changes', DRAFT: 'Back to draft' };
  if (a.state === 'SCHEDULED') Object.assign(trLabel, { APPROVED: 'Unschedule', NEEDS_REVIEW: 'Pull back to review' });
  if (a.state === 'APPROVED') trLabel.NEEDS_REVIEW = 'Send back to review';
  if (a.state === 'FAILED') trLabel.NEEDS_REVIEW = 'Back to review';
  let formatFields = '';
  if (a.format === 'reel' || a.format === 'video') {
    formatFields = `<h3 style="margin-top:14px">Script & storyboard <span class="muted small">${c.durationSec}s · ${esc(c.musicMood || '')}</span></h3>
      <div class="card" style="padding:10px 14px">${(c.storyboard || []).map((s, i) => `<div class="sb-row"><div class="mono">${s.start}–${s.end}s<br><span class="badge b-mute">${esc(s.type)}</span></div><div><input type="text" data-sb="${i}" data-k="onScreenText" value="${esc(s.onScreenText)}" ${locked ? 'disabled' : ''} style="font-weight:600;margin-bottom:4px"><div class="muted small"><b>Shot:</b> ${esc(s.shot)} · <b>Visual:</b> ${esc(s.visual)}</div><textarea data-sb="${i}" data-k="vo" rows="2" ${locked ? 'disabled' : ''} style="min-height:44px;margin-top:4px">${esc(s.vo)}</textarea></div></div>`).join('')}</div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn ghost sm" data-action="render-job" data-id="${a.id}">View render job JSON</button><span class="muted small">Feed to Remotion / FFmpeg / a render API to produce the MP4.</span></div>`;
  } else if (a.format === 'flyer') {
    formatFields = `<div class="form-grid" style="margin-top:10px"><label class="f full">Subhead<input type="text" name="c_subhead" value="${esc(c.subhead)}" ${locked ? 'disabled' : ''}></label><label class="f full">Value props <span class="hint">one per line (max 3)</span><textarea name="c_valueProps" rows="3" ${locked ? 'disabled' : ''}>${esc((c.valueProps || []).join('\n'))}</textarea></label><label class="f">Badge / offer<input type="text" name="c_badge" value="${esc(c.badge || '')}" ${locked ? 'disabled' : ''}></label></div>`;
  } else if (a.format === 'carousel') {
    formatFields = `<h3 style="margin-top:14px">Slides</h3>${(c.slides || []).map((s, i) => `<div class="feat-row" style="grid-template-columns:28px 1fr 1.6fr"><span class="mono" style="padding-top:8px">${i + 1}</span><input type="text" data-slide="${i}" data-k="title" value="${esc(s.title)}" ${locked ? 'disabled' : ''}><input type="text" data-slide="${i}" data-k="body" value="${esc(s.body)}" ${locked ? 'disabled' : ''}></div>`).join('')}`;
  } else if (a.format === 'post') {
    formatFields = `<div class="form-grid" style="margin-top:10px"><label class="f">Image headline<input type="text" name="c_imageHeadline" value="${esc(c.imageHeadline || '')}" ${locked ? 'disabled' : ''}></label><label class="f">Image subline<input type="text" name="c_imageSub" value="${esc(c.imageSub || '')}" ${locked ? 'disabled' : ''}></label></div>`;
  }
  const slides = a.format === 'carousel' ? c.slides?.length || 0 : 0;
  openModal(`${modalHead(esc(a.title), badge(a.state) + scorePill(sc))}
  <div class="modal-body"><div class="editor">
    <div><div class="pv"><img src="${mediaUrl(a, slide)}" alt="preview"></div>
      ${slides ? `<div class="row" style="justify-content:center;margin-top:8px">${Array.from({ length: slides }, (_, i) => `<button class="chip ${i === slide ? 'on' : ''}" data-action="slide" data-id="${a.id}" data-i="${i}">${i + 1}</button>`).join('')}</div>` : ''}
      <div class="row" style="justify-content:center;margin-top:10px"><a class="btn ghost sm" href="${mediaUrl(a, slide)}" download="${a.channel}-${a.format}.svg">Download SVG</a><button class="btn ghost sm" data-action="png" data-src="${mediaUrl(a, slide)}" data-name="${a.channel}-${a.format}-${slide + 1}.png">Download PNG</button><button class="btn signal sm" data-action="share-kit" data-id="${a.id}">Share Kit</button></div>
      <div class="card" style="margin-top:14px"><div class="card-head" style="margin-bottom:8px"><h3 style="margin:0">Hook & virality advisor</h3><button class="link small" data-action="rescore" data-id="${a.id}">Re-score</button></div>
        ${Object.entries({ hook: 'Hook clarity', showDontTell: 'Show-don’t-tell', shareability: 'Shareability', cta: 'CTA & link' }).map(([k, l]) => `<div class="dim"><span>${l}</span><div class="bar ${sc.dims?.[k] >= 70 ? 'ok' : 'signal'}"><i style="width:${sc.dims?.[k] || 0}%"></i></div><span class="mono">${sc.dims?.[k] ?? '–'}</span></div>`).join('')}
        <div style="margin:8px 0">${(sc.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        ${sc.suggestions?.length ? `<div class="eyebrow">Suggestions</div><ul class="clean small">${sc.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
        <div class="eyebrow" style="margin-top:10px">Share mechanics to try</div><ul class="clean small">${(sc.mechanics || []).map((m) => `<li><b>${esc(m.label)}:</b> ${esc(m.idea)}</li>`).join('')}</ul>
        ${sc.reasons?.length ? `<details style="margin-top:8px"><summary class="link small">Why this score</summary><ul class="clean small muted">${sc.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>` : ''}
      </div>
    </div>
    <form data-form="edit-asset" data-id="${a.id}" class="stack" style="gap:10px">
      ${lockNote}${a.review_note && a.state === 'NEEDS_REVISION' ? `<div class="note">✎ Reviewer: ${esc(a.review_note)}</div>` : ''}${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}
      ${c.variationNote ? `<div class="callout info small">${esc(c.variationNote)}</div>` : ''}
      <label class="f">Headline / hook<input type="text" name="headline" value="${esc(a.headline)}" ${locked ? 'disabled' : ''}></label>
      <label class="f">Caption <span class="hint">{{link}} becomes the tracked URL</span><textarea name="caption" rows="8" data-limit="${limit}" ${locked ? 'disabled' : ''}>${esc(a.caption)}</textarea><div class="counter" id="capCount">${a.caption.length} / ${limit}</div></label>
      <div class="form-grid"><label class="f">CTA<input type="text" name="cta" value="${esc(a.cta)}" ${locked ? 'disabled' : ''}></label><label class="f">Hashtags <span class="hint">max ${ch(a.channel).hashtagLimit}</span><input type="text" name="hashtags" value="${esc((a.hashtags || []).join(' '))}" ${locked ? 'disabled' : ''}></label></div>
      ${formatFields}
      <div class="f"><span>Tracked link</span><div class="copybox"><input type="text" readonly value="${esc(a.utm_url || '')}"><button type="button" class="btn ghost sm" data-copy="${esc(a.utm_url || '')}">Copy</button></div></div>
      <div class="spread" style="margin-top:6px">
        <div class="row">${!locked ? '<button class="btn">Save changes</button>' : ''}${transitions.map((s) => `<button type="button" class="btn ${s === 'APPROVED' && a.state !== 'SCHEDULED' ? 'ok' : 'ghost'} sm" data-action="${s === 'NEEDS_REVISION' ? 'request-changes' : 'transition'}" data-to="${s}" data-id="${a.id}">${trLabel[s] || s}</button>`).join('')}</div>
        <div class="row"><input type="text" id="regenInstr" placeholder="Direction for regeneration (optional)" style="width:220px"><button type="button" class="btn ghost sm" data-action="regenerate" data-id="${a.id}" data-modal="1">↻ ${['APPROVED', 'SCHEDULED', 'FAILED', 'PUBLISHED'].includes(a.state) ? 'New variant' : 'Regenerate'}</button></div>
      </div>
      <details><summary class="link small">History (${a.events.length} events${a.jobs.length ? `, ${a.jobs.length} jobs` : ''})</summary>
        <div class="list small" style="margin-top:6px">${a.events.map((e) => `<div class="li"><span class="mono">${fmtDate(e.at, { time: true })}</span><div class="grow">${e.from_state ? `${badge(e.from_state)} → ` : ''}${badge(e.to_state)} <span class="muted">by ${esc(e.actor)}${e.note ? ' — ' + esc(e.note) : ''}</span></div></div>`).join('')}
        ${a.jobs.flatMap((j) => j.log).map((l) => `<div class="li"><span class="lvl ${l.level}"></span><div class="grow">${esc(isoPretty(l.msg))} <span class="muted">${esc(rel(l.at))}</span></div></div>`).join('')}</div></details>
      <div class="muted small">Generated by ${esc(a.generator || 'unknown')} · v${a.version} · ${esc(a.channel)} ${esc(a.aspect_ratio)}</div>
    </form>
  </div></div>`);
}

async function openShareKit(assetId) {
  const k = await api('GET', `/api/assets/${assetId}/share-kit`);
  const a = S.assets.find((x) => x.id === assetId) || (await api('GET', `/api/assets/${assetId}`));
  openModal(`${modalHead(`Share Kit · ${esc(k.channelLabel)}`, `<span class="badge ${k.mode === 'api' ? 'b-api' : 'b-kit'}">${k.mode === 'api' ? 'API channel' : 'manual channel'}</span>`)}
  <div class="modal-body stack">
    <div class="muted small">${esc(k.requirements)}</div>
    <div><div class="eyebrow">1 · Media (pre-sized ${esc(k.media[0]?.aspect)})</div><div class="kit-media">${k.media.map((m, i) => `<figure><img src="${m.svg}" alt=""><div class="row" style="justify-content:space-between"><span class="small">${esc(m.label)}</span><span class="row" style="gap:4px"><a class="btn ghost xs" href="${m.svg}" download="${k.channel}-${i + 1}.svg">SVG</a><button class="btn ghost xs" data-action="png" data-src="${m.svg}" data-name="${k.channel}-${i + 1}.png">PNG</button></span></div></figure>`).join('')}</div>
      ${k.renderJob ? `<div class="row small" style="margin-top:6px"><button class="link" data-action="render-job" data-id="${k.assetId}">Video render job (JSON)</button><span class="muted">— render to MP4, or film it following the storyboard.</span></div>` : ''}</div>
    <div><div class="spread"><div class="eyebrow">2 · Caption</div><span class="counter ${k.overLimit ? 'over' : ''}">${k.captionLength} / ${k.captionLimit}</span></div><textarea rows="7" readonly id="kitCaption">${esc(k.caption)}</textarea><div class="row" style="margin-top:6px"><button class="btn sm" data-copy-el="kitCaption">Copy caption</button></div></div>
    <div><div class="eyebrow">3 · Tracked link</div><div class="copybox"><input type="text" readonly value="${esc(k.link)}"><button class="btn ghost sm" data-copy="${esc(k.link)}">Copy</button></div></div>
    <div><div class="eyebrow">4 · Checklist</div>${k.checklist.map((s) => `<label class="check" style="display:flex;margin:6px 0"><input type="checkbox"> ${esc(s)}</label>`).join('')}</div>
    ${a.state === 'SCHEDULED' ? `<form data-form="mark-published" data-id="${k.assetId}" class="card row" style="flex-wrap:nowrap"><input type="url" name="url" placeholder="Post URL (optional)"><button class="btn ok">Mark as published</button></form>` : `<div class="callout info small"><div>${a.state === 'PUBLISHED' ? 'Already published.' : `This creative is <b>${STATE_LABEL[a.state]}</b>. Approve and schedule it before marking it published, so the approval trail stays intact.`}</div></div>`}
  </div>`);
}

function promptModal({ title, label, placeholder = '', submit = 'Save', onSubmit, textarea = true }) {
  openModal(`${modalHead(esc(title))}<form class="modal-body stack" data-form="prompt"><label class="f">${esc(label)}${textarea ? `<textarea name="v" rows="4" placeholder="${esc(placeholder)}" required></textarea>` : `<input type="text" name="v" placeholder="${esc(placeholder)}" required>`}</label><div class="row"><button class="btn">${esc(submit)}</button><button type="button" class="btn ghost" data-action="close">Cancel</button></div></form>`, { narrow: true });
  S._prompt = onSubmit;
  setTimeout(() => $('#modal-root [name=v]')?.focus(), 30);
}

// ------------------------------------------------------------------ actions
const actions = {
  close: closeModal,
  'close-overlay': (el, e) => e.target === el && closeModal(),
  'open-asset': (el) => openAsset(el.dataset.id),
  slide: (el) => openAsset(el.dataset.id, Number(el.dataset.i)),
  'share-kit': (el) => openShareKit(el.dataset.id),
  async tick(el) {
    const r = await busy(el, () => api('POST', '/api/worker/tick'));
    toast(`Scheduler ran · ${r.processed ?? 0} due job(s) processed`);
    await refreshCampaign();
    render();
  },
  async 'toggle-task'(el) {
    await api('PATCH', `/api/tasks/${el.dataset.id}`, { done: el.checked });
    await refreshCampaign();
    render();
  },
  async 'delete-task'(el) {
    if (!confirm('Delete this task?')) return;
    await api('DELETE', `/api/tasks/${el.dataset.id}`);
    await refreshCampaign();
    render();
  },
  async transition(el) {
    const a = await busy(el, () => api('POST', `/api/assets/${el.dataset.id}/transition`, { to: el.dataset.to }));
    toast(`${a.title.slice(0, 40)} → ${STATE_LABEL[a.state]}`, 'ok');
    await afterAssetChange(a.id);
  },
  'request-changes'(el) {
    const id = el.dataset.id;
    promptModal({
      title: 'Request changes',
      label: 'What should change?',
      placeholder: 'e.g. Lead with the pain point; shorten the hook to under 8 words',
      submit: 'Send back for revision',
      onSubmit: async (v) => {
        await api('POST', `/api/assets/${id}/transition`, { to: 'NEEDS_REVISION', note: v });
        closeModal();
        toast('Sent back for revision');
        await refreshCampaign();
        render();
      },
    });
  },
  async regenerate(el) {
    const instruction = el.dataset.modal ? $('#regenInstr')?.value || '' : '';
    const r = await busy(el, () => api('POST', `/api/assets/${el.dataset.id}/regenerate`, { instruction }));
    toast(r.mode === 'variant' ? 'Created a new draft variant — the approved original is untouched' : `Regenerated (v${r.asset.version})`, 'ok');
    await refreshCampaign();
    render();
    if (el.dataset.modal) openAsset(r.asset.id);
  },
  async schedule(el) {
    const id = el.dataset.id;
    const when = $(`#when-${id}`).value;
    const autoPublish = $(`#auto-${id}`).checked;
    await busy(el, () => api('POST', `/api/assets/${id}/schedule`, { runAt: new Date(when).toISOString(), autoPublish }));
    toast(`Scheduled for ${fmtDate(new Date(when).toISOString(), { time: true })}`, 'ok');
    await refreshCampaign();
    render();
  },
  async 'schedule-now'(el) {
    const id = el.dataset.id;
    await busy(el, async () => {
      await api('POST', `/api/assets/${id}/schedule`, { runAt: new Date().toISOString(), autoPublish: $(`#auto-${id}`).checked });
      await api('POST', '/api/worker/tick');
    });
    await refreshCampaign();
    render();
    const a = S.assets.find((x) => x.id === id);
    toast(a?.state === 'PUBLISHED' ? 'Published ✓' : a?.state === 'SCHEDULED' ? 'Queued — this one needs the Share Kit or a retry (see publish log)' : `Now ${STATE_LABEL[a?.state]}`, a?.state === 'PUBLISHED' ? 'ok' : '');
  },
  async unschedule(el) {
    await busy(el, () => api('POST', `/api/assets/${el.dataset.id}/unschedule`));
    await refreshCampaign();
    render();
  },
  async retry(el) {
    await busy(el, async () => {
      await api('POST', `/api/assets/${el.dataset.id}/retry`, {});
      await api('POST', '/api/worker/tick');
    });
    await refreshCampaign();
    render();
  },
  async 'submit-drafts'(el) {
    const r = await busy(el, () => api('POST', `/api/campaigns/${S.cmpId}/submit-drafts`));
    toast(`${r.submitted} draft(s) submitted for review`, 'ok');
    await refreshCampaign();
    render();
  },
  async iterate(el) {
    const a = await busy(el, () => api('POST', `/api/campaigns/${S.cmpId}/iterate`, { assetId: el.dataset.id }));
    toast('Follow-up variation drafted from the top performer', 'ok');
    await refreshCampaign();
    render();
    openAsset(a.id);
  },
  async rescore(el) {
    await api('POST', `/api/assets/${el.dataset.id}/score`);
    openAsset(el.dataset.id);
  },
  async 'render-job'(el) {
    const job = await api('GET', `/api/assets/${el.dataset.id}/render-job`);
    openModal(`${modalHead('Video render job')}<div class="modal-body"><p class="muted small">Renderer-agnostic spec. Map scenes to your Remotion composition, an FFmpeg pipeline, or a render API. Footage marked <span class="mono">screen_recording</span> should be a real capture of your product.</p><div class="code">${esc(JSON.stringify(job, null, 2))}</div><div class="row" style="margin-top:10px"><button class="btn sm" data-copy="${esc(JSON.stringify(job, null, 2))}">Copy JSON</button></div></div>`);
  },
  async png(el) {
    await svgToPng(el.dataset.src, el.dataset.name);
  },
  'add-metrics'(el) {
    const id = el.dataset.id;
    openModal(`${modalHead('Add real metrics')}<form class="modal-body stack" data-form="metrics" data-id="${id}"><p class="muted small">Enter numbers from the platform’s insights. They’re stored as <b>manual</b> and shown alongside webhook conversions.</p><div class="form-grid">${['impressions', 'clicks', 'shares', 'signups'].map((k) => `<label class="f">${k}<input type="number" min="0" name="${k}" value="0"></label>`).join('')}<label class="f">Date<input type="date" name="date" value="${todayIso()}"></label></div><div class="row"><button class="btn">Save metrics</button></div></form>`, { narrow: true });
  },
  'filter-format': (el) => ((S.ui.studioFormat = el.dataset.v), render()),
  'filter-state': (el) => ((S.ui.studioState = el.dataset.v), render()),
  'filter-cat': (el) => ((S.ui.taskCat = el.dataset.v), render()),
  'task-view': (el) => ((S.ui.taskView = el.dataset.v), render()),
  'hide-done': (el) => ((S.ui.hideDone = el.checked), render()),
  'add-feature': () => $('#features').insertAdjacentHTML('beforeend', featRow()),
  'remove-feature': (el) => el.closest('.feat-row').remove(),
  async 'remove-logo'() {
    S.ws = await api('PATCH', `/api/workspaces/${S.wsId}`, { brand: { ...S.ws.brand, logo: null } });
    render();
  },
  async 'remove-shot'(el) {
    const shots = S.ws.screenshots.filter((_, i) => i !== Number(el.dataset.i));
    S.ws = await api('PATCH', `/api/workspaces/${S.wsId}`, { screenshots: shots });
    render();
  },
  async 'channel-mode'(el) {
    await api('PATCH', `/api/channels/${el.dataset.id}`, { mode: el.value }).catch((e) => toast(e.message, 'bad'));
    S.channels = await api('GET', `/api/workspaces/${S.wsId}/channels`);
    await refreshCampaign();
    render();
  },
  async 'channel-auto'(el) {
    await api('PATCH', `/api/channels/${el.dataset.id}`, { auto_publish: el.checked });
    S.channels = await api('GET', `/api/workspaces/${S.wsId}/channels`);
    toast(`Auto-publish ${el.checked ? 'on' : 'off'}`);
    await refreshCampaign();
    render();
  },
  async 'rotate-secret'() {
    if (!confirm('Rotate the webhook secret? Integrations using the old one will start failing.')) return;
    S.ws = await api('POST', `/api/workspaces/${S.wsId}/rotate-secret`);
    render();
    toast('Webhook secret rotated');
  },
  reveal(el) {
    const f = $('#secretField');
    f.type = f.type === 'password' ? 'text' : 'password';
    el.textContent = f.type === 'password' ? 'Show' : 'Hide';
  },
  async 'webhook-events'() {
    const ev = await api('GET', `/api/workspaces/${S.wsId}/webhook-events`);
    openModal(`${modalHead('Recent webhook events')}<div class="modal-body">${ev.length ? `<table class="t"><thead><tr><th>Received</th><th>Type</th><th>Result</th></tr></thead><tbody>${ev.map((e) => `<tr><td class="mono">${fmtDate(e.received_at, { time: true })}</td><td>${esc(e.type)}</td><td class="mono" style="white-space:pre-wrap">${esc(JSON.stringify(e.result))}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No events yet.</div>'}</div>`);
  },
  'copy-utm': () => copy($('#utmOut').value),
  'new-workspace'() {
    openModal(`${modalHead('New workspace')}<form class="modal-body stack" data-form="new-workspace"><label class="f">Product name<input type="text" name="name" required placeholder="Acme Analytics"></label><label class="f">Website <span class="hint">optional — import it on the next screen</span><input type="url" name="website_url" placeholder="https://acme.com"></label><div class="row"><button class="btn">Create workspace</button></div></form>`, { narrow: true });
  },
  'new-campaign'() {
    if (!S.ws) return actions['new-workspace']();
    const d = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    openModal(`${modalHead('New campaign')}<form class="modal-body stack" data-form="new-campaign">
      <label class="f">Campaign name<input type="text" name="name" required value="${esc(S.ws.name)} launch"></label>
      <div class="form-grid"><label class="f">Goal<input type="text" name="goal" value="Drive trial signups"></label><label class="f">Launch date<input type="date" name="launch_date" value="${d}" required></label></div>
      <label class="f">Landing URL <span class="hint">UTM-tagged per creative</span><input type="url" name="base_url" value="${esc(S.ws.website_url || '')}"></label>
      <div class="f">Channels<div class="chips">${Object.entries(S.config.channels).map(([k, c]) => `<label class="chip-check"><input type="checkbox" name="channels" value="${k}" ${['instagram', 'linkedin', 'x', 'tiktok'].includes(k) ? 'checked' : ''}>${esc(c.label)}</label>`).join('')}</div></div>
      <label class="check small"><input type="checkbox" name="generate" checked> Generate the creative package right away</label>
      <div class="row"><button class="btn signal">Create campaign</button></div></form>`, { narrow: true });
  },
};

async function afterAssetChange(id) {
  await refreshCampaign();
  render();
  if ($('#modal-root .editor')) openAsset(id);
}

// ------------------------------------------------------------------ forms
const forms = {
  async 'ingest-url'(f, fd, btn) {
    const r = await busy(btn, () => api('POST', `/api/workspaces/${S.wsId}/ingest`, { url: fd.get('url') }));
    S.ws = r.workspace;
    toast(`Imported ${r.workspace.features.length} features from ${new URL(fd.get('url')).hostname}`, 'ok');
    render();
  },
  async 'ingest-text'(f, fd, btn) {
    const r = await busy(btn, () => api('POST', `/api/workspaces/${S.wsId}/ingest`, { text: fd.get('text') }));
    S.ws = r.workspace;
    toast('Analyzed pasted details', 'ok');
    render();
  },
  async workspace(f, fd, btn) {
    const lines = (k) => String(fd.get(k) || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const features = [...f.querySelectorAll('.feat-row')].map((r) => ({ name: r.querySelector('[data-feat=name]').value, benefit: r.querySelector('[data-feat=benefit]').value })).filter((x) => x.name || x.benefit);
    const body = {
      name: fd.get('name'),
      tagline: fd.get('tagline'),
      description: fd.get('description'),
      audience: fd.get('audience'),
      pricing: fd.get('pricing'),
      offer: fd.get('offer'),
      referral_mechanics: fd.get('referral_mechanics'),
      features,
      value_props: lines('value_props'),
      pain_points: lines('pain_points'),
      brand: { ...S.ws.brand, colors: { primary: fd.get('color_primary'), secondary: fd.get('color_secondary'), accent: fd.get('color_accent') }, fonts: { heading: fd.get('font_heading'), body: fd.get('font_body') } },
      locale: { language: fd.get('language'), region: fd.get('region'), currency: fd.get('currency'), dateFormat: fd.get('dateFormat'), tone: fd.get('tone') },
    };
    S.ws = await busy(btn, () => api('PATCH', `/api/workspaces/${S.wsId}`, body));
    S.workspaces = await api('GET', '/api/workspaces');
    renderSelectors();
    toast('Workspace saved — regenerate drafts to pick up changes', 'ok');
    render();
  },
  async generate(f, fd, btn) {
    const body = { channels: fd.getAll('channels'), formats: fd.getAll('formats'), instruction: fd.get('instruction'), includeLocked: !!fd.get('includeLocked') };
    const r = await busy(btn, () => api('POST', `/api/campaigns/${S.cmpId}/generate`, body));
    toast(`${r.created.length} new · ${r.replaced.length} drafts refreshed · ${r.skippedLocked.length} locked kept`, 'ok');
    await refreshCampaign();
    render();
  },
  async 'edit-asset'(f, fd, btn) {
    const a = S.assets.find((x) => x.id === f.dataset.id) || (await api('GET', `/api/assets/${f.dataset.id}`));
    const content = {};
    if (a.format === 'flyer') Object.assign(content, { subhead: fd.get('c_subhead'), valueProps: String(fd.get('c_valueProps') || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3), badge: fd.get('c_badge') || null });
    if (a.format === 'post') Object.assign(content, { imageHeadline: fd.get('c_imageHeadline'), imageSub: fd.get('c_imageSub') });
    if (a.format === 'carousel') {
      const slides = (a.content.slides || []).map((s) => ({ ...s }));
      f.querySelectorAll('[data-slide]').forEach((i) => (slides[i.dataset.slide][i.dataset.k] = i.value));
      content.slides = slides;
    }
    if (a.format === 'reel' || a.format === 'video') {
      const sb = (a.content.storyboard || []).map((s) => ({ ...s }));
      f.querySelectorAll('[data-sb]').forEach((i) => (sb[i.dataset.sb][i.dataset.k] = i.value));
      content.storyboard = sb;
      content.voiceover = sb.map((s) => s.vo).join(' ');
      content.captions = sb.map((s) => ({ start: s.start, end: s.end, text: s.vo }));
      content.hook = sb[0]?.vo || a.content.hook;
    } else content.hook = fd.get('headline');
    const updated = await busy(btn, () => api('PATCH', `/api/assets/${a.id}`, { headline: fd.get('headline'), caption: fd.get('caption'), cta: fd.get('cta'), hashtags: fd.get('hashtags'), content }));
    toast(updated.state !== a.state ? `Saved — moved to ${STATE_LABEL[updated.state]} for re-approval` : 'Saved', 'ok');
    await afterAssetChange(a.id);
  },
  async 'mark-published'(f, fd, btn) {
    await busy(btn, () => api('POST', `/api/assets/${f.dataset.id}/mark-published`, { url: fd.get('url') || null }));
    closeModal();
    toast('Marked as published — review task added for 48h', 'ok');
    await refreshCampaign();
    render();
  },
  async metrics(f, fd, btn) {
    await busy(btn, () => api('POST', `/api/assets/${f.dataset.id}/metrics`, Object.fromEntries(fd)));
    closeModal();
    await refreshCampaign();
    render();
  },
  async utm(f, fd, btn) {
    const r = await busy(btn, () => api('POST', '/api/utm', Object.fromEntries(fd)));
    $('#utmOut').value = r.url;
  },
  async 'add-task'(f, fd, btn) {
    await busy(btn, () => api('POST', `/api/campaigns/${S.cmpId}/tasks`, Object.fromEntries(fd)));
    await refreshCampaign();
    render();
  },
  async prompt(f, fd) {
    await S._prompt?.(fd.get('v'));
  },
  async 'new-workspace'(f, fd, btn) {
    const ws = await busy(btn, () => api('POST', '/api/workspaces', { name: fd.get('name'), website_url: fd.get('website_url') || null }));
    closeModal();
    await loadWorkspaces(ws.id);
    location.hash = '#/workspace';
  },
  async 'new-campaign'(f, fd, btn) {
    const body = { name: fd.get('name'), goal: fd.get('goal'), launch_date: fd.get('launch_date'), base_url: fd.get('base_url') || null, channels: fd.getAll('channels') };
    const c = await busy(btn, async () => {
      const c = await api('POST', `/api/workspaces/${S.wsId}/campaigns`, body);
      if (fd.get('generate')) await api('POST', `/api/campaigns/${c.id}/generate`, {});
      return c;
    });
    closeModal();
    await loadWorkspace(c.id);
    location.hash = '#/studio';
    toast('Campaign created with launch checklist', 'ok');
  },
};

// ------------------------------------------------------------------ helpers
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed — select and copy manually', 'bad');
  }
}
async function svgToPng(src, name) {
  const svg = await (await fetch(src)).text();
  const m = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  const [w, h] = m ? [Number(m[1]), Number(m[2])] : [1080, 1080];
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await img.decode();
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.getContext('2d').drawImage(img, 0, 0, w, h);
  canvas.toBlob((b) => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(b), download: name });
    a.click();
  }, 'image/png');
}
const readFile = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });

// ------------------------------------------------------------------ event wiring
document.addEventListener('click', async (e) => {
  const cp = e.target.closest('[data-copy]');
  if (cp) return copy(cp.dataset.copy);
  const cpe = e.target.closest('[data-copy-el]');
  if (cpe) return copy($('#' + cpe.dataset.copyEl).value);
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type === 'checkbox' && !['toggle-task', 'hide-done', 'channel-auto'].includes(el.dataset.action))) return;
  if (el.tagName === 'INPUT' && el.type === 'checkbox') return; // handled on change
  const fn = actions[el.dataset.action];
  if (!fn) return;
  if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
  try {
    await fn(el, e);
  } catch (err) {
    if (!el.classList.contains('busy')) toast(err.message, 'bad');
  }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.id === 'wsSelect') {
    S.wsId = el.value;
    return loadWorkspace();
  }
  if (el.id === 'cmpSelect') {
    S.cmpId = el.value;
    return loadCampaign();
  }
  if (el.dataset.upload) {
    const file = el.files[0];
    if (!file) return;
    const dataUrl = await readFile(file);
    const body = el.dataset.upload === 'logo' ? { brand: { ...S.ws.brand, logo: dataUrl } } : { screenshots: [...(S.ws.screenshots || []), { name: file.name, dataUrl }] };
    try {
      S.ws = await api('PATCH', `/api/workspaces/${S.wsId}`, body);
      toast('Uploaded', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
    return render();
  }
  const fn = el.dataset.action && actions[el.dataset.action];
  if (fn && (el.tagName === 'SELECT' || el.type === 'checkbox')) {
    try {
      await fn(el, e);
    } catch (err) {
      toast(err.message, 'bad');
    }
  }
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  try {
    await forms[f.dataset.form]?.(f, new FormData(f), f.querySelector('button:not([type=button])'));
  } catch {
    /* toast already shown */
  }
});
document.addEventListener('input', (e) => {
  if (e.target.name === 'caption' && e.target.dataset.limit) {
    const c = $('#capCount');
    const n = e.target.value.length;
    c.textContent = `${n} / ${e.target.dataset.limit}`;
    c.classList.toggle('over', n > Number(e.target.dataset.limit));
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());

boot().catch((e) => {
  $('#view').innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
});
