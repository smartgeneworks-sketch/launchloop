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
  [S.ws, S.channels, S.campaigns, S.media] = await Promise.all([api('GET', `/api/workspaces/${S.wsId}`), api('GET', `/api/workspaces/${S.wsId}/channels`), api('GET', `/api/workspaces/${S.wsId}/campaigns`), api('GET', `/api/workspaces/${S.wsId}/media`)]);
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
  if (!document.hidden) refreshHealth();
  if (!S.cmpId || document.hidden || $('#modal-root').children.length) return;
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) && $('#view').contains(active)) return;
  const prev = S.progress?.assets.states;
  const changed = await refreshCampaign().catch(() => false);
  if (!changed) return;
  if (prev && S.progress.assets.states.PUBLISHED > prev.PUBLISHED) toast('Scheduler published a creative ✓', 'ok');
  if (['dashboard', 'review', 'timeline', 'analytics', 'studio'].includes(route())) render();
}

async function refreshHealth() {
  try {
    S.health = await api('GET', '/api/health');
    renderModes();
  } catch {}
}
function renderModes() {
  const h = S.health;
  const err = h.ai.lastError;
  $('#modes').innerHTML = `
    <div class="mode-pill"><span><span class="dot ${err ? 'bad' : h.ai.provider !== 'mock' ? 'live' : ''}"></span>AI</span><b>${esc(h.ai.provider)}${h.ai.model ? ' · ' + esc(h.ai.model) : ''}</b></div>
    ${err ? `<div class="ai-warn" title="${esc(err.message)}">⚠ AI request failed (${esc(err.message)}) — creatives fell back to templates. ${esc(err.hint || '')}</div>` : ''}
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
        <div class="row"><label class="f" style="flex:1">Heading font<select name="font_heading" data-action="font-change">${fontOptions(w.brand?.fonts?.heading || 'Inter')}</select></label><label class="f" style="flex:1">Body font<select name="font_body" data-action="font-change">${fontOptions(w.brand?.fonts?.body || 'Inter')}</select></label></div>
        <div class="full">${brandPreview(w)}</div>
        <div class="full"><div class="eyebrow" style="margin-bottom:6px">Font pairings ${suggestedPairing(w) ? `<span class="muted" style="text-transform:none;letter-spacing:0">· suggested for a ${esc(w.locale?.tone || 'friendly')} tone: <b>${esc(suggestedPairing(w).name)}</b></span>` : ''}</div>
          <div class="chips">${S.config.pairings.map((pp) => `<button type="button" class="chip ${pp.heading === w.brand?.fonts?.heading && pp.body === w.brand?.fonts?.body ? 'on' : ''}" data-action="apply-pairing" data-h="${esc(pp.heading)}" data-b="${esc(pp.body)}" style="font-family:'${esc(pp.heading)}',sans-serif">${esc(pp.name)} · ${esc(pp.heading)} + ${esc(pp.body)}</button>`).join('')}</div></div>
        ${siteThemeCard(w)}
        <div><div class="f" style="margin-bottom:6px;font-size:12px;font-weight:600;color:var(--ink-2)">Logo</div><div class="row">${w.brand?.logo ? `<span class="logo-pv"><img src="${esc(w.brand.logo)}" alt="logo"></span><button type="button" class="btn xs ghost" data-action="remove-logo">Remove</button>` : '<span class="muted small">No logo — wordmark is used</span>'}<label class="btn ghost sm">Upload<input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" data-upload="logo" hidden></label></div></div>
      </div>
      <h3 style="margin-top:18px">Media library <span class="muted small">— screenshots & pictures for your demos</span></h3>
      <p class="muted small" style="margin:0 0 8px">Label each image with what it shows (e.g. “upload camera roll photo”, “auto-crop result”, “print sheet 35×45”). Video scenes automatically pick the image whose label matches the scene, and you can choose exactly which image appears in each scene in the video editor.</p>
      <div class="media-grid">${(S.media || []).map((m) => `<figure class="media-item"><img src="${esc(m.url)}" alt="" loading="lazy"><input type="text" value="${esc(m.label || '')}" placeholder="What does this show?" data-media-label="${esc(m.id)}"><div class="row" style="justify-content:space-between"><span class="muted small">${m.brandKit ? 'brand kit' : esc(Math.round((m.bytes || 0) / 1024) + ' KB')}</span>${m.brandKit ? `<button type="button" class="link small" data-action="remove-shot" data-i="${esc(m.id.split('_').pop())}">remove</button>` : `<button type="button" class="link small" data-action="delete-media" data-id="${esc(m.id)}">delete</button>`}</div></figure>`).join('')}
        <label class="media-add">+ Upload images<span class="muted small">PNG / JPG · several at once</span><input type="file" accept="image/*" multiple data-upload="media" hidden></label></div>
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
// ---- fonts & theme helpers
const loadedFonts = new Set();
function loadGoogleFonts(names) {
  const todo = [...new Set(names.filter(Boolean))].filter((n) => !loadedFonts.has(n) && S.config.fonts.some((f) => f.name === n));
  if (!todo.length) return;
  todo.forEach((n) => loadedFonts.add(n));
  const q = todo.map((n) => `family=${encodeURIComponent(n).replace(/%20/g, '+')}:wght@${S.config.fonts.find((f) => f.name === n).weights.join(';')}`).join('&');
  document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${q}&display=swap">`);
}
function fontOptions(current) {
  const cats = { sans: 'Sans-serif', display: 'Display / headline', serif: 'Serif' };
  const list = S.config.fonts;
  const extra = current && !list.some((f) => f.name === current) ? `<option selected value="${esc(current)}">${esc(current)} (not in library — system font used)</option>` : '';
  return extra + Object.entries(cats).map(([k, label]) => `<optgroup label="${label}">${list.filter((f) => f.cat === k).map((f) => `<option value="${esc(f.name)}" ${f.name === current ? 'selected' : ''}>${esc(f.name)} — ${esc(f.vibe)}</option>`).join('')}</optgroup>`).join('');
}
const suggestedPairing = (w) => S.config.pairings.find((pp) => pp.tones.includes(w.locale?.tone || 'friendly'));
function brandPreview(w, fonts = w.brand?.fonts || {}, colors = w.brand?.colors || {}) {
  loadGoogleFonts([fonts.heading, fonts.body, ...S.config.pairings.map((pp) => pp.heading)]);
  const fg = lumHex(colors.primary) > 0.45 ? '#111418' : '#fff';
  const onA = lumHex(colors.accent) > 0.45 ? '#111418' : '#fff';
  return `<div class="brand-preview" id="brandPreview" style="background:linear-gradient(135deg,${esc(colors.primary || '#1F2A44')},${esc(colors.secondary || '#3B4C7A')});color:${fg}">
    <div style="font-family:'${esc(fonts.heading || 'Inter')}',sans-serif;font-weight:800;font-size:26px;line-height:1.1">${esc(w.tagline || w.name || 'Your headline here')}</div>
    <div style="font-family:'${esc(fonts.body || 'Inter')}',sans-serif;font-size:14px;opacity:.88;margin:8px 0 12px">${esc((w.value_props || [])[0] || 'Body text in your brand font, exactly as it appears in flyers and videos.')}</div>
    <span style="font-family:'${esc(fonts.body || 'Inter')}',sans-serif;font-weight:700;background:${esc(colors.accent || '#FFB547')};color:${onA};padding:6px 14px;border-radius:999px;font-size:13px">Try it free →</span></div>`;
}
function lumHex(hex) {
  const n = parseInt(String(hex || '#000').replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function siteThemeCard(w) {
  const sg = w.source_meta?.brandSuggestion;
  if (!sg || (!sg.colors && !sg.fonts)) return `<div class="full muted small">Tip: import your website above and LaunchLoop will suggest colours and fonts that match it.</div>`;
  return `<div class="full callout info" style="align-items:center"><div><b>Theme from your website</b>
    <div class="row" style="margin-top:6px">${sg.colors ? Object.entries(sg.colors).map(([k, v]) => `<span class="swatch" title="${k} ${esc(v)}" style="background:${esc(v)}"></span>`).join('') : ''}
    ${sg.fonts ? `<span class="small">Fonts: <b>${esc(sg.fonts.heading)}</b> + <b>${esc(sg.fonts.body)}</b></span>` : sg.detectedFonts?.length ? `<span class="small muted">Site uses ${esc(sg.detectedFonts.slice(0, 2).join(', '))} (not in the font library — pick the closest pairing)</span>` : ''}</div></div>
    <button type="button" class="btn sm" data-action="apply-site-theme">Apply site theme</button></div>`;
}

function updateBrandPreview() {
  const f = $('form[data-form=workspace]');
  const el = $('#brandPreview');
  if (!f || !el) return;
  const fd = new FormData(f);
  const fonts = { heading: fd.get('font_heading'), body: fd.get('font_body') };
  const colors = { primary: fd.get('color_primary'), secondary: fd.get('color_secondary'), accent: fd.get('color_accent') };
  el.outerHTML = brandPreview({ ...S.ws, ...Object.fromEntries(['tagline', 'name'].map((k) => [k, fd.get(k)])) }, fonts, colors);
}
async function downscaleImage(file, max = 1920) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const png = file.type === 'image/png' ? canvas.toDataURL('image/png') : null;
  return png && png.length < 5_500_000 ? png : canvas.toDataURL('image/jpeg', 0.9);
}
async function uploadMedia(file, label) {
  const dataUrl = await downscaleImage(file);
  return api('POST', `/api/workspaces/${S.wsId}/media`, { name: file.name, label: label || file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' '), dataUrl });
}

// ---- scene media (mirror of server resolveSceneMedia)
const STOPW = new Set(['with', 'your', 'that', 'this', 'from', 'into', 'then', 'they', 'them', 'have', 'more', 'than', 'just', 'what', 'when', 'will', 'shot', 'screen', 'recording', 'visual', 'showing', 'product', 'scene']);
const wordSet = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((x) => x.length > 3 && !STOPW.has(x)));
function resolveSceneMedia(scene, index, library) {
  const choice = scene.media?.id;
  if (choice === 'none') return null;
  if (choice && choice !== 'auto') {
    const item = library.find((m) => m.id === choice);
    if (item) return { item, fit: scene.media.fit || 'contain', zoom: scene.media.zoom !== false, auto: false };
  }
  if (!library.length || scene.type === 'cta') return null;
  const sw = wordSet(`${scene.onScreenText} ${scene.vo} ${scene.visual} ${scene.shot}`);
  let best = null;
  let bs = 0;
  for (const m of library) {
    const sc = [...wordSet(`${m.label} ${m.name}`)].filter((x) => sw.has(x)).length;
    if (sc > bs) (best = m), (bs = sc);
  }
  return { item: best || library[index % library.length], fit: scene.media?.fit || 'contain', zoom: scene.media?.zoom !== false, auto: true, matched: !!best };
}
function mediaSelect(attrs, current, { allowAuto = true, defaultLabel = 'Auto (match by label)' } = {}) {
  return `<select ${attrs}>${allowAuto ? `<option value="auto" ${!current || current === 'auto' ? 'selected' : ''}>${defaultLabel}</option>` : ''}<option value="none" ${current === 'none' ? 'selected' : ''}>No image (brand background)</option>${(S.media || []).map((m) => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.label || m.name)}</option>`).join('')}</select>`;
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
    ${a.parent_id ? `<div class="muted small">↳ variation · v${a.version}</div>` : `<div class="muted small">v${a.version} · ${esc((a.generator || '').split(' ')[0])}</div>`}
    ${/fallback/.test(a.generator || '') ? `<div class="fallback-badge" title="${esc(a.generator)}">⚠ AI failed — template copy. Regenerate after fixing.</div>` : ''}</div>
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
      <p class="muted small" style="margin:0 0 6px">Choose exactly which screenshot or picture appears in each scene. Upload more in <b>Product source → Media library</b>, or right here.</p>
      <div class="card" style="padding:10px 14px">${(c.storyboard || []).map((s, i) => {
        const r = resolveSceneMedia(s, i, S.media || []);
        return `<div class="sb-row sb-media-row"><div class="mono">${s.start}–${s.end}s<br><span class="badge b-mute">${esc(s.type)}</span></div><div><input type="text" data-sb="${i}" data-k="onScreenText" value="${esc(s.onScreenText)}" ${locked ? 'disabled' : ''} style="font-weight:600;margin-bottom:4px"><div class="muted small"><b>Shot:</b> ${esc(s.shot)} · <b>Visual:</b> ${esc(s.visual)}</div><textarea data-sb="${i}" data-k="vo" rows="2" ${locked ? 'disabled' : ''} style="min-height:44px;margin-top:4px">${esc(s.vo)}</textarea>
          <div class="scene-media"><div class="scene-thumb">${r ? `<img src="${esc(r.item.url)}" alt="" style="object-fit:${r.fit === 'cover' ? 'cover' : 'contain'}">` : '<span>brand<br>background</span>'}</div>
            <div class="stack" style="gap:6px;flex:1"><div class="row" style="flex-wrap:nowrap;gap:6px">${mediaSelect(`data-sbm="${i}" data-k="id" ${locked ? 'disabled' : ''}`, s.media?.id)}
              <select data-sbm="${i}" data-k="fit" ${locked ? 'disabled' : ''} style="width:150px"><option value="contain" ${(s.media?.fit || 'contain') === 'contain' ? 'selected' : ''}>Show whole image</option><option value="cover" ${s.media?.fit === 'cover' ? 'selected' : ''}>Fill the frame</option></select></div>
              <div class="row small" style="gap:12px"><label class="check"><input type="checkbox" data-sbm="${i}" data-k="zoom" ${s.media?.zoom !== false ? 'checked' : ''} ${locked ? 'disabled' : ''}> slow zoom</label>
              ${r?.auto ? `<span class="muted">${r.matched ? 'auto-matched by label' : 'auto (no label matched — pick one)'}</span>` : ''}
              ${locked ? '' : `<label class="link small" style="cursor:pointer">+ upload for this scene<input type="file" accept="image/*" data-upload="scene-media" data-asset="${a.id}" data-scene="${i}" hidden></label>`}</div></div></div></div></div>`;
      }).join('')}</div>
      <div class="row" style="margin-top:8px"><button type="button" class="btn ghost sm" data-action="render-job" data-id="${a.id}">View render job JSON</button><span class="muted small">Feed to Remotion / FFmpeg / a render API to produce the MP4.</span></div>`;
  } else if (a.format === 'flyer') {
    formatFields = `<div class="form-grid" style="margin-top:10px"><label class="f full">Subhead<input type="text" name="c_subhead" value="${esc(c.subhead)}" ${locked ? 'disabled' : ''}></label><label class="f full">Value props <span class="hint">one per line (max 3)</span><textarea name="c_valueProps" rows="3" ${locked ? 'disabled' : ''}>${esc((c.valueProps || []).join('\n'))}</textarea></label><label class="f">Badge / offer<input type="text" name="c_badge" value="${esc(c.badge || '')}" ${locked ? 'disabled' : ''}></label>${imagePicker(c, locked)}</div>`;
  } else if (a.format === 'carousel') {
    formatFields = `<h3 style="margin-top:14px">Slides</h3>${(c.slides || []).map((s, i) => `<div class="feat-row" style="grid-template-columns:28px 1fr 1.6fr"><span class="mono" style="padding-top:8px">${i + 1}</span><input type="text" data-slide="${i}" data-k="title" value="${esc(s.title)}" ${locked ? 'disabled' : ''}><input type="text" data-slide="${i}" data-k="body" value="${esc(s.body)}" ${locked ? 'disabled' : ''}></div>`).join('')}`;
  } else if (a.format === 'post') {
    formatFields = `<div class="form-grid" style="margin-top:10px"><label class="f">Image headline<input type="text" name="c_imageHeadline" value="${esc(c.imageHeadline || '')}" ${locked ? 'disabled' : ''}></label><label class="f">Image subline<input type="text" name="c_imageSub" value="${esc(c.imageSub || '')}" ${locked ? 'disabled' : ''}></label>${imagePicker(c, locked)}</div>`;
  }
  const slides = a.format === 'carousel' ? c.slides?.length || 0 : 0;
  openModal(`${modalHead(esc(a.title), badge(a.state) + scorePill(sc))}
  <div class="modal-body"><div class="editor">
    <div><div class="pv"><img src="${mediaUrl(a, slide)}" alt="preview"></div>
      ${slides ? `<div class="row" style="justify-content:center;margin-top:8px">${Array.from({ length: slides }, (_, i) => `<button class="chip ${i === slide ? 'on' : ''}" data-action="slide" data-id="${a.id}" data-i="${i}">${i + 1}</button>`).join('')}</div>` : ''}
      <div class="row" style="justify-content:center;margin-top:10px"><a class="btn ghost sm" href="${mediaUrl(a, slide)}" download="${a.channel}-${a.format}.svg">Download SVG</a><button class="btn ghost sm" data-action="png" data-src="${mediaUrl(a, slide)}" data-name="${a.channel}-${a.format}-${slide + 1}.png">Download PNG</button><button class="btn signal sm" data-action="share-kit" data-id="${a.id}">Share Kit</button></div>
      ${a.format === 'reel' || a.format === 'video' ? `<div class="row" style="justify-content:center;margin-top:8px"><button class="btn sm" data-action="record-video" data-id="${a.id}">🎬 Download video (${c.durationSec || ''}s)</button></div><p class="muted small" style="text-align:center;margin:6px 0 0">With AI voiceover, music and burned-in captions. Records in real time — keep this tab open.</p>` : ''}
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

function imagePicker(c, locked) {
  return `<label class="f">Picture${mediaSelect(`name="c_media_id" ${locked ? 'disabled' : ''}`, c.media?.id, { defaultLabel: 'Default (first screenshot)' })}</label>
    <label class="f">Picture fit<select name="c_media_fit" ${locked ? 'disabled' : ''}><option value="cover" ${(c.media?.fit || 'cover') === 'cover' ? 'selected' : ''}>Fill the frame</option><option value="contain" ${c.media?.fit === 'contain' ? 'selected' : ''}>Show whole image</option></select></label>`;
}

async function openShareKit(assetId) {
  const k = await api('GET', `/api/assets/${assetId}/share-kit`);
  const a = S.assets.find((x) => x.id === assetId) || (await api('GET', `/api/assets/${assetId}`));
  openModal(`${modalHead(`Share Kit · ${esc(k.channelLabel)}`, `<span class="badge ${k.mode === 'api' ? 'b-api' : 'b-kit'}">${k.mode === 'api' ? 'API channel' : 'manual channel'}</span>`)}
  <div class="modal-body stack">
    <div class="muted small">${esc(k.requirements)}</div>
    <div><div class="eyebrow">1 · Media (pre-sized ${esc(k.media[0]?.aspect)})</div><div class="kit-media">${k.media.map((m, i) => `<figure><img src="${m.svg}" alt=""><div class="row" style="justify-content:space-between"><span class="small">${esc(m.label)}</span><span class="row" style="gap:4px"><a class="btn ghost xs" href="${m.svg}" download="${k.channel}-${i + 1}.svg">SVG</a><button class="btn ghost xs" data-action="png" data-src="${m.svg}" data-name="${k.channel}-${i + 1}.png">PNG</button></span></div></figure>`).join('')}</div>
      ${k.renderJob ? `<div class="row small" style="margin-top:6px"><button class="btn sm" data-action="record-video" data-id="${k.assetId}">🎬 Download video</button><button class="link" data-action="render-job" data-id="${k.assetId}">Video render job (JSON)</button><span class="muted">— render to MP4, or film it following the storyboard.</span></div>` : ''}</div>
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
    await refreshHealth();
    warnIfFallback([r.asset.id]);
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
  'font-change'() {
    updateBrandPreview();
  },
  async 'apply-pairing'(el) {
    S.ws = await api('PATCH', `/api/workspaces/${S.wsId}`, { brand: { ...S.ws.brand, fonts: { heading: el.dataset.h, body: el.dataset.b } } });
    toast(`Fonts set to ${el.dataset.h} + ${el.dataset.b}`, 'ok');
    render();
  },
  async 'apply-site-theme'() {
    const sg = S.ws.source_meta?.brandSuggestion || {};
    S.ws = await api('PATCH', `/api/workspaces/${S.wsId}`, { brand: { ...S.ws.brand, ...(sg.colors ? { colors: sg.colors } : {}), ...(sg.fonts ? { fonts: sg.fonts } : {}) } });
    toast('Applied your website’s colours and fonts', 'ok');
    render();
  },
  async 'delete-media'(el) {
    if (!confirm('Delete this image? Scenes using it will fall back to auto.')) return;
    await api('DELETE', `/api/media/${el.dataset.id}`);
    S.media = await api('GET', `/api/workspaces/${S.wsId}/media`);
    render();
  },
  'record-video'(el) {
    openVideoSettings(el.dataset.id);
  },
  async 'start-recording'(el) {
    if (el.classList.contains('busy')) return;
    const f = $('#videoSettings');
    const opts = {
      voiceover: f.querySelector('[name=voiceover]').checked,
      voice: f.querySelector('[name=voice]').value,
      style: f.querySelector('[name=style]').value,
      music: f.querySelector('[name=music]').value,
      musicVolume: Number(f.querySelector('[name=musicVolume]').value) / 100,
      musicFile: f.querySelector('[name=musicFile]')?.files?.[0] || S._musicFile || null,
    };
    const { musicFile, ...persist } = opts;
    localStorage.setItem('ll_video', JSON.stringify(persist));
    if (opts.music === 'upload' && !opts.musicFile) return toast('Choose a music file first', 'bad');
    S._musicFile = opts.musicFile;
    const label = el.textContent;
    el.classList.add('busy');
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const name = await recordVideo(el.dataset.id, opts, actx, (txt) => (el.textContent = txt));
      toast(`Video saved: ${name}`, 'ok');
    } catch (e) {
      toast(e.message, 'bad');
    } finally {
      actx.close().catch(() => {});
      el.classList.remove('busy');
      el.textContent = label;
    }
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
    S.media = await api('GET', `/api/workspaces/${S.wsId}/media`);
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

function warnIfFallback(ids) {
  const failed = S.assets.filter((a) => ids.includes(a.id) && /fallback/.test(a.generator || ''));
  if (failed.length) toast(`⚠ ${failed.length} creative(s) used template copy because the AI request failed (${failed[0].generator.replace(/^mock \(fallback: |\)$/g, '')}). ${S.health?.ai?.lastError?.hint || ''}`, 'bad');
}
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
    await refreshHealth();
    warnIfFallback([...r.created, ...r.replaced]);
    render();
  },
  async 'edit-asset'(f, fd, btn) {
    const a = S.assets.find((x) => x.id === f.dataset.id) || (await api('GET', `/api/assets/${f.dataset.id}`));
    const content = {};
    if (a.format === 'flyer') Object.assign(content, { subhead: fd.get('c_subhead'), valueProps: String(fd.get('c_valueProps') || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3), badge: fd.get('c_badge') || null });
    if (a.format === 'post') Object.assign(content, { imageHeadline: fd.get('c_imageHeadline'), imageSub: fd.get('c_imageSub') });
    if ((a.format === 'post' || a.format === 'flyer') && fd.has('c_media_id')) content.media = { id: fd.get('c_media_id') === 'auto' ? null : fd.get('c_media_id'), fit: fd.get('c_media_fit') };
    if (a.format === 'carousel') {
      const slides = (a.content.slides || []).map((s) => ({ ...s }));
      f.querySelectorAll('[data-slide]').forEach((i) => (slides[i.dataset.slide][i.dataset.k] = i.value));
      content.slides = slides;
    }
    if (a.format === 'reel' || a.format === 'video') {
      const sb = (a.content.storyboard || []).map((s) => ({ ...s }));
      f.querySelectorAll('[data-sb]').forEach((i) => (sb[i.dataset.sb][i.dataset.k] = i.value));
      f.querySelectorAll('[data-sbm]').forEach((i) => {
        const sc = sb[i.dataset.sbm];
        sc.media = { ...(sc.media || {}), [i.dataset.k]: i.type === 'checkbox' ? i.checked : i.value };
      });
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
// ------------------------------------------------------------------ video recorder (canvas → MediaRecorder)
const loadImg = (src) =>
  new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = src;
  });
const unlink = (t) => String(t || '').replace(/\s*\{\{\s*link\s*\}\}\s*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
function wrapCanvas(ctx, text, maxW) {
  const words = unlink(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
const lum = (hex) => {
  const n = parseInt(String(hex || '#000').replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

const MUSIC_MOODS = {
  upbeat: { label: 'Upbeat pop', bpm: 108, wave: 'triangle', chords: [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]], kick: 'four', hat: 8, clap: true, arp: true },
  chill: { label: 'Chill lo-fi', bpm: 84, wave: 'sine', chords: [[0, 4, 7, 11], [9, 12, 16, 19], [5, 9, 12, 16], [7, 11, 14, 17]], kick: 'half', hat: 8, clap: false, arp: false },
  corporate: { label: 'Clean corporate', bpm: 100, wave: 'triangle', chords: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]], kick: 'half', hat: 0, clap: false, arp: true },
  energetic: { label: 'Energetic electronic', bpm: 124, wave: 'sawtooth', chords: [[9, 12, 16], [5, 9, 12], [0, 4, 7], [7, 11, 14]], kick: 'four', hat: 16, clap: true, arp: true },
};
function guessMood(text) {
  const t = String(text || '').toLowerCase();
  if (/lo-?fi|chill|calm|warm|ambient/.test(t)) return 'chill';
  if (/electro|driving|energetic|fast|120|124/.test(t)) return 'energetic';
  if (/corporate|piano|clean|minimal/.test(t)) return 'corporate';
  return 'upbeat';
}

async function openVideoSettings(assetId) {
  const a = await api('GET', `/api/assets/${assetId}`);
  const tts = await api('GET', '/api/tts').catch(() => ({ available: false, voices: [] }));
  const saved = JSON.parse(localStorage.getItem('ll_video') || '{}');
  const mood = saved.music || guessMood(a.content?.musicMood);
  const voices = tts.voices?.length ? tts.voices : [{ id: 'Puck', label: 'Puck — upbeat' }];
  openModal(`${modalHead('Download video')}
  <form class="modal-body stack" id="videoSettings" onsubmit="return false">
    <div class="muted small">${esc(a.title)} · ${esc(a.aspect_ratio)} · ${a.content?.durationSec || ''}s planned. Records in real time in this tab — keep it open and visible.</div>
    <div class="card stack" style="gap:10px">
      <label class="row" style="justify-content:space-between"><b>🎙 Voiceover</b><span class="toggle"><input type="checkbox" name="voiceover" ${tts.available && saved.voiceover !== false ? 'checked' : ''} ${tts.available ? '' : 'disabled'}><span></span></span></label>
      ${tts.available ? `<div class="form-grid"><label class="f">Voice<select name="voice">${voices.map((v) => `<option value="${esc(v.id)}" ${v.id === (saved.voice || 'Puck') ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
      <label class="f">Delivery style <span class="hint">optional</span><input type="text" name="style" value="${esc(saved.style ?? 'energetic and friendly, like a product demo')}"></label></div>
      <div class="muted small">Reads each scene's voiceover script with ${esc(tts.provider)} (${esc(tts.model)}). Scenes stretch to fit the narration. Audio is cached, so re-recording is free.</div>` : `<div class="muted small">Needs GEMINI_API_KEY or OPENAI_API_KEY on the server.</div><input type="hidden" name="voice" value="Puck"><input type="hidden" name="style" value="">`}
    </div>
    <div class="card stack" style="gap:10px">
      <b>🎵 Music</b>
      <div class="form-grid">
        <label class="f">Track<select name="music" onchange="document.getElementById('musicUpload').style.display=this.value==='upload'?'block':'none'">
          ${Object.entries(MUSIC_MOODS).map(([k, m]) => `<option value="${k}" ${k === mood ? 'selected' : ''}>Generated · ${m.label}</option>`).join('')}
          <option value="upload" ${mood === 'upload' ? 'selected' : ''}>Upload my own track…</option>
          <option value="none" ${mood === 'none' ? 'selected' : ''}>No music</option></select></label>
        <label class="f">Music volume<input type="range" name="musicVolume" min="0" max="100" value="${saved.musicVolume != null ? Math.round(saved.musicVolume * 100) : 55}"></label>
      </div>
      <div id="musicUpload" style="display:${mood === 'upload' ? 'block' : 'none'}"><input type="file" name="musicFile" accept="audio/*"><div class="muted small">MP3, WAV or M4A. Use music you have the rights to — it loops to fit and fades out.</div></div>
      <div class="muted small">Generated tracks are original and created on your computer, so there are no licensing issues. Music automatically ducks under the voice.</div>
    </div>
    <div class="row"><button type="button" class="btn signal" data-action="start-recording" data-id="${a.id}">🎬 Record &amp; download</button><button type="button" class="btn ghost" data-action="close">Cancel</button></div>
  </form>`, { narrow: true });
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
function noiseBuffer(ctx) {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
/** Original procedural backing track rendered into an (offline) audio context. */
function synthMusic(ctx, out, moodKey, D) {
  const m = MUSIC_MOODS[moodKey] || MUSIC_MOODS.upbeat;
  const beat = 60 / m.bpm;
  const bar = beat * 4;
  const root = 57; // A3 area; chords are offsets from C so this lands in a comfortable key
  const noise = noiseBuffer(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = m.wave === 'sawtooth' ? 2200 : 3200;
  lp.connect(out);
  const note = (freq, t, dur, { type = m.wave, gain = 0.05, attack = 0.02, dest = lp } = {}) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  };
  const perc = (t, { freq = 7000, type = 'highpass', gain = 0.06, dur = 0.05 } = {}) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.02);
  };
  const kick = (t) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    g.gain.setValueAtTime(0.75, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.3);
  };
  for (let b = 0, t = 0; t < D; b++, t = b * bar) {
    const ch = m.chords[b % m.chords.length];
    const intro = b === 0;
    ch.forEach((n) => note(midiHz(root + n), t, bar * 0.98, { gain: m.wave === 'sawtooth' ? 0.025 : 0.045, attack: 0.25 }));
    for (let k = 0; k < 4; k++) {
      const bt = t + k * beat;
      if (bt >= D) break;
      note(midiHz(root - 12 + ch[0]), bt, beat * (m.bpm < 90 ? 1.6 : 0.85), { type: 'triangle', gain: 0.16, attack: 0.01, dest: out });
      if (!intro && (m.kick === 'four' || (m.kick === 'half' && k % 2 === 0))) kick(bt);
      if (!intro && m.clap && k % 2 === 1) perc(bt, { freq: 1500, type: 'bandpass', gain: 0.18, dur: 0.14 });
      if (m.arp) for (let e = 0; e < 2; e++) note(midiHz(root + 12 + ch[(k * 2 + e) % ch.length]), bt + (e * beat) / 2, beat * 0.45, { type: 'triangle', gain: 0.035, attack: 0.005 });
    }
    if (!intro && m.hat) for (let h = 0; h < m.hat; h++) {
      const ht = t + (h * bar) / m.hat;
      if (ht < D) perc(ht, { gain: h % 2 ? 0.035 : 0.055 });
    }
  }
}

const b64ToBuf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

/** Build the mixed soundtrack (voice + ducked music) and the scene timeline it implies. */
async function buildSoundtrack(asset, sb, opts, onProgress) {
  let vo = null;
  if (opts.voiceover) {
    onProgress?.('Generating voiceover…');
    vo = await api('POST', `/api/assets/${asset.id}/voiceover`, { voice: opts.voice, style: opts.style });
  }
  const rate = 44100;
  const decodeCtx = new OfflineAudioContext(2, rate, rate);
  const voBufs = vo ? await Promise.all(vo.scenes.map((x) => (x.audio ? decodeCtx.decodeAudioData(b64ToBuf(x.audio)) : null))) : sb.map(() => null);
  // Stretch scenes so narration never gets cut off.
  let cursor = 0;
  const timeline = sb.map((s, i) => {
    const planned = Math.max(1, s.end - s.start);
    const need = voBufs[i] ? voBufs[i].duration + 0.45 : 0;
    const dur = Math.max(planned, need);
    const scene = { ...s, start: cursor, end: cursor + dur, voAt: cursor + 0.15 };
    cursor += dur;
    return scene;
  });
  const D = cursor + 0.6;
  if (!opts.voiceover && opts.music === 'none') return { timeline, D, buffer: null };
  onProgress?.('Mixing audio…');
  const ctx = new OfflineAudioContext(2, Math.ceil(D * rate), rate);
  const master = ctx.createDynamicsCompressor();
  master.threshold.value = -14;
  master.ratio.value = 3;
  master.connect(ctx.destination);
  if (opts.music !== 'none') {
    const mg = ctx.createGain();
    const vol = Math.max(0, Math.min(1, opts.musicVolume ?? 0.55));
    mg.gain.setValueAtTime(vol, 0);
    timeline.forEach((s, i) => {
      if (!voBufs[i]) return;
      const a = s.voAt;
      const b = a + voBufs[i].duration;
      mg.gain.setValueAtTime(vol, Math.max(0, a - 0.2));
      mg.gain.linearRampToValueAtTime(vol * 0.3, a);
      mg.gain.setValueAtTime(vol * 0.3, b);
      mg.gain.linearRampToValueAtTime(vol, b + 0.3);
    });
    mg.gain.setValueAtTime(mg.gain.value, Math.max(0, D - 1.4));
    mg.gain.linearRampToValueAtTime(0, D);
    mg.connect(master);
    if (opts.music === 'upload' && opts.musicFile) {
      const buf = await ctx.decodeAudioData(await opts.musicFile.arrayBuffer());
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(mg);
      src.start(0);
    } else synthMusic(ctx, mg, opts.music, D);
  }
  timeline.forEach((s, i) => {
    if (!voBufs[i]) return;
    const src = ctx.createBufferSource();
    src.buffer = voBufs[i];
    const g = ctx.createGain();
    g.gain.value = 1.1;
    src.connect(g).connect(master);
    src.start(s.voAt);
  });
  return { timeline, D, buffer: await ctx.startRendering() };
}

async function recordVideo(assetId, opts, actx, onProgress) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('This browser cannot record video. Use Chrome or Edge on a computer.');
  const mime = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('No supported video format in this browser. Use Chrome or Edge.');
  const a = await api('GET', `/api/assets/${assetId}`);
  const c = a.content || {};
  const planned = (c.storyboard || []).slice().sort((x, y) => x.start - y.start);
  if (!planned.length) throw new Error('This creative has no storyboard to record.');
  const { timeline: sb, D, buffer } = await buildSoundtrack(a, planned, opts, onProgress);
  const [W, H] = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080], '1.91:1': [1200, 628] }[a.aspect_ratio] || [1080, 1920];
  const M = Math.min(W, H);
  const vertical = H > W;
  const brand = S.ws.brand || {};
  const col = { primary: '#1F2A44', secondary: '#3B4C7A', accent: '#FFB547', ...(brand.colors || {}) };
  const fg = lum(col.primary) > 0.45 ? '#111418' : '#FFFFFF';
  const onAccent = lum(col.accent) > 0.45 ? '#111418' : '#FFFFFF';
  const hFont = `'${brand.fonts?.heading || 'Inter'}', Inter, 'Helvetica Neue', Arial, sans-serif`;
  const bFont = `'${brand.fonts?.body || 'Inter'}', Inter, 'Helvetica Neue', Arial, sans-serif`;
  const logo = brand.logo ? await loadImg(brand.logo) : null;
  // Brand fonts: self-hosted by the server so canvas text uses the real typeface.
  onProgress?.('Loading fonts & images…');
  if (!document.getElementById('wsFonts-' + S.ws.id)) {
    await new Promise((res) => {
      const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', id: 'wsFonts-' + S.ws.id, href: `/api/workspaces/${S.ws.id}/fonts.css` });
      l.onload = l.onerror = res;
      document.head.appendChild(l);
    });
  }
  await Promise.all([document.fonts.load(`800 40px '${brand.fonts?.heading || 'Inter'}'`), document.fonts.load(`600 40px '${brand.fonts?.body || 'Inter'}'`), document.fonts.load(`400 40px '${brand.fonts?.body || 'Inter'}'`)]).catch(() => {});
  const library = S.media || [];
  const sceneMedia = sb.map((s, i) => resolveSceneMedia(s, i, library));
  const imgCache = {};
  for (const r of sceneMedia) if (r && !imgCache[r.item.id]) imgCache[r.item.id] = await loadImg(r.item.url);
  let domain = '';
  try {
    domain = new URL(S.campaign?.base_url || S.ws.website_url).hostname.replace(/^www\./, '');
  } catch {}

  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const pad = M * 0.07;

  function draw(t) {
    const idx = Math.max(0, sb.findIndex((s) => t >= s.start && t < s.end));
    const s = t >= D ? sb.at(-1) : sb[idx];
    const p = (t - s.start) / Math.max(0.1, s.end - s.start);
    const enter = ease((t - s.start) / 0.45);
    // background
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, col.primary);
    g.addColorStop(1, col.secondary);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = col.accent;
    ctx.beginPath();
    ctx.arc(W * 0.9 - t * 4, H * 0.86, M * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.05;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(W * 0.06 + t * 3, H * 0.06, M * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    // logo
    const lh = M * 0.065;
    if (logo) ctx.drawImage(logo, pad, pad, (logo.width / logo.height) * lh, lh);
    else {
      ctx.fillStyle = fg;
      ctx.font = `800 ${lh * 0.7}px ${hFont}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(S.ws.name || '', pad, pad + lh / 2);
    }
    let y = pad + lh + M * 0.05;
    // headline
    const isCta = s.type === 'cta';
    const fs = vertical ? W * 0.082 : H * 0.085;
    ctx.font = `800 ${fs}px ${hFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const lines = wrapCanvas(ctx, s.onScreenText, W - pad * 2).slice(0, vertical ? 5 : 3);
    ctx.globalAlpha = enter;
    ctx.fillStyle = fg;
    const headTop = y + (1 - enter) * fs * 0.6 + fs;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, headTop + i * fs * 1.08));
    ctx.globalAlpha = 1;
    y = headTop + (lines.length - 1) * fs * 1.08 + fs * 0.6;
    // subtitle box size (bottom)
    const sfs = vertical ? W * 0.038 : H * 0.042;
    ctx.font = `600 ${sfs}px ${bFont}`;
    const sub = wrapCanvas(ctx, s.vo, W - pad * 2.6).slice(0, 3);
    const subH = sub.length * sfs * 1.35 + sfs * 0.9;
    const subY = H - pad * 1.3 - subH;
    // media area
    const areaH = subY - y - pad * 0.5;
    const sm = sceneMedia[idx];
    const shot = sm ? imgCache[sm.item.id] : null;
    if (isCta) {
      let cfs = M * 0.052;
      const label = unlink(a.cta).replace(/\s*\(link in bio\)/i, '') + ' →';
      ctx.font = `800 ${cfs}px ${bFont}`;
      while (ctx.measureText(label).width + cfs * 2.4 > W - pad * 2 && cfs > M * 0.026) {
        cfs *= 0.92;
        ctx.font = `800 ${cfs}px ${bFont}`;
      }
      const bw = ctx.measureText(label).width + cfs * 2.4;
      const bh = cfs * 2.3;
      const by = y + areaH / 2 - bh;
      const pulse = 1 + Math.sin(t * 5) * 0.02;
      ctx.save();
      ctx.translate(W / 2, by + bh / 2);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = col.accent;
      rrect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
      ctx.fill();
      ctx.fillStyle = onAccent;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 0);
      ctx.restore();
      if (domain) {
        ctx.fillStyle = fg;
        ctx.globalAlpha = 0.85;
        ctx.font = `600 ${M * 0.04}px ${bFont}`;
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(/link in bio/i.test(a.cta) ? 'Link in bio' : domain, W / 2, by + bh + M * 0.09);
        ctx.globalAlpha = 1;
      }
    } else if (areaH > M * 0.15) {
      const fw = W - pad * 2;
      const fx = pad;
      const fh = areaH;
      const fy = y;
      ctx.save();
      rrect(ctx, fx, fy, fw, fh, M * 0.025);
      ctx.clip();
      if (shot) {
        const zoom = sm.zoom ? 1 + 0.08 * p : 1;
        const cover = Math.max(fw / shot.width, fh / shot.height);
        const contain = Math.min(fw / shot.width, fh / shot.height);
        if (sm.fit !== 'cover') {
          // Show the whole screenshot: blurred fill behind, full image in front.
          ctx.filter = 'blur(18px) brightness(0.6)';
          ctx.drawImage(shot, fx + (fw - shot.width * cover) / 2, fy + (fh - shot.height * cover) / 2, shot.width * cover, shot.height * cover);
          ctx.filter = 'none';
        }
        const scale = (sm.fit === 'cover' ? cover : contain) * zoom;
        const iw = shot.width * scale;
        const ih = shot.height * scale;
        if (s.type === 'hook' && sm.auto) ctx.filter = 'blur(6px) brightness(0.55)';
        if (s.type === 'problem' && sm.auto) ctx.filter = 'grayscale(0.85) brightness(0.8)';
        ctx.drawImage(shot, fx + (fw - iw) / 2, sm.fit === 'cover' ? fy + (fh - ih) * 0.2 : fy + (fh - ih) / 2, iw, ih);
        ctx.filter = 'none';
        if (s.type === 'proof' && sm.auto) {
          ctx.font = `800 ${M * 0.036}px ${bFont}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          const tw = ctx.measureText('BEFORE → AFTER').width;
          ctx.fillStyle = col.accent;
          rrect(ctx, fx + M * 0.025, fy + M * 0.025, tw + M * 0.05, M * 0.065, M * 0.0325);
          ctx.fill();
          ctx.fillStyle = onAccent;
          ctx.fillText('BEFORE → AFTER', fx + M * 0.05, fy + M * 0.025 + M * 0.0325);
          ctx.textAlign = 'center';
        }
      } else {
        // No screenshot uploaded: animated brand shapes instead of director notes.
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(fx, fy, fw, fh);
        ctx.fillStyle = col.accent;
        for (let k = 0; k < 3; k++) {
          ctx.globalAlpha = 0.25 + 0.2 * k;
          ctx.beginPath();
          ctx.arc(fx + fw * (0.3 + 0.2 * k), fy + fh / 2 + Math.sin(t * 2 + k) * fh * 0.08, M * (0.05 + 0.02 * k), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
    // subtitles
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    rrect(ctx, pad, subY, W - pad * 2, subH, M * 0.02);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${sfs}px ${bFont}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    sub.forEach((l, i) => ctx.fillText(l, W / 2, subY + sfs * 1.2 + i * sfs * 1.35));
    // progress
    ctx.fillStyle = col.accent;
    ctx.fillRect(0, H - M * 0.012, (W * Math.min(t, D)) / D, M * 0.012);
  }

  const stream = canvas.captureStream(30);
  let src = null;
  if (buffer) {
    await actx.resume();
    const dest = actx.createMediaStreamDestination();
    src = actx.createBufferSource();
    src.buffer = buffer;
    src.connect(dest);
    dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
  }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  draw(0);
  rec.start(500);
  const startAt = actx.currentTime + 0.05;
  if (src) src.start(startAt);
  const t0 = performance.now();
  const clock = () => (src ? Math.max(0, actx.currentTime - startAt) : (performance.now() - t0) / 1000);
  await new Promise((resolve) => {
    const tick = () => {
      const t = clock();
      draw(Math.min(t, D));
      onProgress?.(`Recording… ${Math.max(0, Math.ceil(D - t))}s left`);
      if (t >= D + 0.3) return resolve();
      setTimeout(tick, 1000 / 30);
    };
    tick();
  });
  rec.stop();
  await stopped;
  stream.getTracks().forEach((tr) => tr.stop());
  let blob = new Blob(chunks, { type: mime.split(';')[0] });
  let ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  const standard = mime.includes('avc1') && (!buffer || mime.includes('mp4a'));
  if (!standard) {
    // Browser recorded VP9/Opus — convert server-side to H.264 + AAC so every platform accepts it.
    onProgress?.('Converting to MP4…');
    try {
      const headers = { 'content-type': 'application/octet-stream' };
      const tok = localStorage.getItem('ll_token');
      if (tok) headers.authorization = `Bearer ${tok}`;
      const r = await fetch('/api/transcode', { method: 'POST', headers, body: blob });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      blob = await r.blob();
      ext = 'mp4';
    } catch (e) {
      toast(`Could not convert to H.264 MP4 (${e.message}). Saved the original ${ext.toUpperCase()} — convert it in CapCut before uploading to Instagram.`, 'bad');
    }
  }
  const name = `${(S.ws.name || 'video').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${a.channel}-${a.format}.${ext}`;
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  link.click();
  return name;
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
  if (el.dataset.mediaLabel) {
    await api('PATCH', `/api/media/${el.dataset.mediaLabel}`, { label: el.value }).catch((err) => toast(err.message, 'bad'));
    const m = (S.media || []).find((x) => x.id === el.dataset.mediaLabel);
    if (m) m.label = el.value;
    return toast('Label saved');
  }
  if (el.name?.startsWith('color_')) return updateBrandPreview();
  if (el.dataset.upload === 'media') {
    const files = [...el.files];
    if (!files.length) return;
    toast(`Uploading ${files.length} image(s)…`);
    for (const file of files) await uploadMedia(file).catch((err) => toast(`${file.name}: ${err.message}`, 'bad'));
    S.media = await api('GET', `/api/workspaces/${S.wsId}/media`);
    toast('Uploaded — add a label to each so scenes can match them', 'ok');
    return render();
  }
  if (el.dataset.upload === 'scene-media') {
    const file = el.files[0];
    if (!file) return;
    const row = el.closest('.sb-row');
    const label = row?.querySelector('[data-k=onScreenText]')?.value || '';
    try {
      const m = await uploadMedia(file, label);
      S.media = await api('GET', `/api/workspaces/${S.wsId}/media`);
      const sel = row.querySelector('select[data-k=id]');
      sel.insertAdjacentHTML('beforeend', `<option value="${esc(m.id)}">${esc(m.label || m.name)}</option>`);
      sel.value = m.id;
      row.querySelector('.scene-thumb').innerHTML = `<img src="${esc(m.url)}" alt="" style="object-fit:contain">`;
      toast('Image added to this scene — click Save changes', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
    return;
  }
  if (el.dataset.sbm !== undefined && el.dataset.k === 'id') {
    const m = (S.media || []).find((x) => x.id === el.value);
    el.closest('.sb-row').querySelector('.scene-thumb').innerHTML = m ? `<img src="${esc(m.url)}" alt="" style="object-fit:contain">` : el.value === 'none' ? '<span>brand<br>background</span>' : '<span>auto</span>';
    return;
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
