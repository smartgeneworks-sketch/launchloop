/**
 * Domain logic. Routes stay thin and call these; the worker and webhooks reuse them.
 * ctx = { db, ai, config }
 */
import crypto from 'node:crypto';
import { CHANNELS, TASK_CATEGORIES, specsFor } from '../lib/channels.js';
import { HttpError, addDays, id, isoDate, nowIso, slugify, timingSafeEqualStr } from '../lib/util.js';
import { ingestUrl } from './ingest.js';
import { stripLinkTokens } from './ai.js';
import { scoreAsset } from './scorer.js';
import { LOCKED_STATES, REPLACEABLE_STATES, transition } from './stateMachine.js';
import { assetUtmUrl, parseUtmContent } from './utm.js';

const must = (row, what) => {
  if (!row) throw new HttpError(404, `${what} not found`);
  return row;
};
const today = () => isoDate(new Date());

// ============================================================ workspaces
export function createWorkspace({ db, config }, data = {}) {
  if (!data.name) throw new HttpError(400, 'Workspace name is required');
  return db.tx(() => {
    const ws = db.insert('workspaces', {
      id: id('ws'),
      name: data.name,
      website_url: data.website_url || null,
      tagline: data.tagline || '',
      description: data.description || '',
      features: data.features || [],
      value_props: data.value_props || [],
      pain_points: data.pain_points || [],
      hooks: data.hooks || [],
      audience: data.audience || '',
      pricing: data.pricing || '',
      offer: data.offer || '',
      referral_mechanics: data.referral_mechanics || '',
      brand: data.brand || { colors: { primary: '#1F2A44', secondary: '#3B4C7A', accent: '#FFB547' }, fonts: { heading: 'Inter', body: 'Inter' } },
      locale: data.locale || { language: 'en', region: 'US', currency: 'USD', dateFormat: 'MMM D, YYYY', tone: 'friendly' },
      screenshots: data.screenshots || [],
      source_meta: {},
      webhook_secret: `whsec_${crypto.randomBytes(18).toString('hex')}`,
    });
    for (const [ch, def] of Object.entries(CHANNELS)) {
      db.insert('channel_connections', {
        id: id('chn'),
        workspace_id: ws.id,
        channel: ch,
        mode: def.defaultMode,
        status: def.defaultMode === 'api' ? apiStatus(config, ch) : 'connected',
        account_label: def.defaultMode === 'api' ? `${data.name} (${config.publishMode === 'mock' ? 'mock' : 'not connected'})` : 'Share Kit',
        auto_publish: def.defaultMode === 'api',
        token_ref: null,
      });
    }
    return ws;
  });
}

const WS_FIELDS = ['name', 'website_url', 'tagline', 'description', 'features', 'value_props', 'pain_points', 'hooks', 'audience', 'pricing', 'offer', 'referral_mechanics', 'brand', 'locale', 'screenshots'];
export function updateWorkspace({ db }, wsId, patch = {}) {
  must(db.byId('workspaces', wsId), 'Workspace');
  const clean = {};
  for (const k of WS_FIELDS) if (k in patch) clean[k] = patch[k];
  if (clean.brand?.logo && !/^data:image\/(png|jpe?g|svg\+xml|webp);base64,/.test(clean.brand.logo)) throw new HttpError(400, 'Logo must be a PNG, JPG, SVG or WebP image');
  if (clean.brand?.logo && clean.brand.logo.length > 800_000) throw new HttpError(413, 'Logo must be under ~600 KB');
  if (clean.screenshots) {
    if (!Array.isArray(clean.screenshots) || clean.screenshots.length > 4) throw new HttpError(400, 'Up to 4 screenshots');
    for (const s of clean.screenshots) if (!/^data:image\//.test(s?.dataUrl || '') || s.dataUrl.length > 2_000_000) throw new HttpError(400, 'Screenshots must be images under ~1.5 MB');
  }
  if (clean.features) clean.features = clean.features.filter((f) => f && (f.name || f.benefit)).map((f) => ({ name: String(f.name || '').trim(), benefit: String(f.benefit || '').trim() }));
  return db.update('workspaces', wsId, clean);
}

export async function ingestWorkspace({ db, ai }, wsId, { url, text } = {}) {
  const ws = must(db.byId('workspaces', wsId), 'Workspace');
  if (!url && !text) throw new HttpError(400, 'Provide a website URL or paste product details');
  let pages = [];
  let notes = [];
  let extracted = {};
  if (url) ({ pages, extracted, notes } = await ingestUrl(url));
  const analysis = await ai.analyzeProduct({ url, text, extracted });
  const patch = {
    name: ws.name && ws.name !== 'Untitled product' ? ws.name : analysis.name,
    tagline: analysis.tagline,
    description: analysis.description,
    features: analysis.features,
    value_props: analysis.value_props,
    pain_points: analysis.pain_points,
    hooks: analysis.hooks,
    audience: analysis.audience || ws.audience,
    pricing: analysis.pricing || ws.pricing,
    referral_mechanics: ws.referral_mechanics || analysis.referral_mechanics,
    source_meta: { url: url || null, manual: !url, pages, notes, generator: analysis.generator, importedAt: nowIso(), brandSuggestion: extracted.brandSuggestion || null },
  };
  if (url) patch.website_url = url;
  return { workspace: db.update('workspaces', wsId, patch), analysis, notes };
}

export function updateChannel({ db, config }, chnId, patch = {}) {
  const c = must(db.byId('channel_connections', chnId), 'Channel connection');
  const out = {};
  if ('mode' in patch) {
    if (!['api', 'share_kit'].includes(patch.mode)) throw new HttpError(400, 'mode must be api or share_kit');
    if (patch.mode === 'api' && !CHANNELS[c.channel].apiAvailable) throw new HttpError(400, `${CHANNELS[c.channel].label} has no official publishing API — it stays on the Share Kit`);
    out.mode = patch.mode;
    out.status = patch.mode === 'api' ? apiStatus(config, c.channel) : 'connected';
    if (patch.mode === 'share_kit') out.auto_publish = false;
  }
  if ('auto_publish' in patch) out.auto_publish = !!patch.auto_publish && (out.mode || c.mode) === 'api';
  if ('account_label' in patch) out.account_label = String(patch.account_label).slice(0, 80);
  return db.update('channel_connections', chnId, out);
}

const LIVE_CREDS = { x: ['X_USER_ACCESS_TOKEN'], linkedin: ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_AUTHOR_URN'], telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] };
/** Live mode: a channel counts as connected only when its credentials are configured and a live adapter exists. */
export const hasLiveCreds = (channel, env = {}) => !!LIVE_CREDS[channel]?.every((k) => env[k]);
function apiStatus(config, channel) {
  if (config.publishMode === 'mock') return 'mock';
  return hasLiveCreds(channel, config.env) ? 'connected' : 'disconnected';
}
export function syncChannelStatuses({ db, config }) {
  // Backfill connection rows for channels added after a workspace was created.
  for (const ws of db.all(null, 'SELECT id, name FROM workspaces')) {
    for (const [ch, def] of Object.entries(CHANNELS)) {
      if (connectionFor(db, ws.id, ch)) continue;
      db.insert('channel_connections', { id: id('chn'), workspace_id: ws.id, channel: ch, mode: def.defaultMode, status: def.defaultMode === 'api' ? apiStatus(config, ch) : 'connected', account_label: def.defaultMode === 'api' ? ws.name : 'Share Kit', auto_publish: def.defaultMode === 'api', token_ref: null });
    }
  }
  for (const c of db.all('channel_connections', `SELECT * FROM channel_connections WHERE mode = 'api'`)) {
    const status = apiStatus(config, c.channel);
    if (status !== c.status) db.update('channel_connections', c.id, { status, account_label: status === 'connected' ? 'Connected via env credentials' : status === 'mock' ? 'mock' : 'Not connected — add credentials' });
  }
}

export const connectionFor = (db, workspaceId, channel) => db.get('channel_connections', 'SELECT * FROM channel_connections WHERE workspace_id = ? AND channel = ?', workspaceId, channel);

// ============================================================ campaigns & tasks
export async function createCampaign(ctx, wsId, data = {}) {
  const { db, ai } = ctx;
  const ws = must(db.byId('workspaces', wsId), 'Workspace');
  const channels = (data.channels || []).filter((c) => CHANNELS[c]);
  if (!channels.length) throw new HttpError(400, 'Pick at least one channel');
  const name = data.name || `${ws.name} launch`;
  const launch = data.launch_date ? new Date(data.launch_date) : addDays(new Date(), 10);
  if (Number.isNaN(launch.getTime())) throw new HttpError(400, 'Invalid launch date');
  const campaign = db.insert('campaigns', {
    id: id('cmp'),
    workspace_id: wsId,
    name,
    goal: data.goal || 'Drive signups',
    base_url: data.base_url || ws.website_url,
    utm_campaign: slugify(data.utm_campaign || name).replace(/-/g, '_'),
    channels,
    launch_date: isoDate(launch),
    status: 'active',
    source: data.source || 'manual',
  });
  const { tasks } = await ai.generateTasks({ workspace: ws, campaign });
  db.tx(() => tasks.forEach((t, i) => insertTask(db, campaign, { ...t, sort: i })));
  return campaign;
}

function insertTask(db, campaign, t) {
  return db.insert('campaign_tasks', {
    id: id('tsk'),
    campaign_id: campaign.id,
    title: t.title,
    description: t.description || '',
    category: TASK_CATEGORIES.includes(t.category) ? t.category : 'Setup',
    role: t.role || 'Marketer',
    due_date: t.due_date || isoDate(addDays(campaign.launch_date, t.dayOffset || 0)),
    done: !!t.done,
    done_at: t.done ? nowIso() : null,
    source: t.source || 'auto',
    asset_id: t.asset_id || null,
    sort: t.sort ?? 100,
  });
}
export const addTask = ({ db }, campaignId, t) => insertTask(db, must(db.byId('campaigns', campaignId), 'Campaign'), { ...t, source: t.source || 'manual' });

export function updateTask({ db }, taskId, patch) {
  must(db.byId('campaign_tasks', taskId), 'Task');
  const out = {};
  for (const k of ['title', 'description', 'role', 'due_date']) if (k in patch) out[k] = patch[k];
  if ('category' in patch) {
    if (!TASK_CATEGORIES.includes(patch.category)) throw new HttpError(400, 'Unknown category');
    out.category = patch.category;
  }
  if ('done' in patch) {
    out.done = !!patch.done;
    out.done_at = patch.done ? nowIso() : null;
  }
  return db.update('campaign_tasks', taskId, out);
}

/** Create a follow-up task once (dedup by title within the campaign). */
function ensureTask(db, campaign, t) {
  const exists = db.get('campaign_tasks', 'SELECT id FROM campaign_tasks WHERE campaign_id = ? AND title = ? AND done = 0', campaign.id, t.title);
  return exists || insertTask(db, campaign, t);
}

// ============================================================ creative assets
async function buildAsset(ctx, { campaign, workspace, spec, version = 1, parent = null, variationOf = null, metrics = null, instruction = '', genWorkspace = null, seed = '' }) {
  const gen = await ctx.ai.generateAsset({ workspace: genWorkspace || workspace, campaign, channel: spec.channel, format: spec.format, version, variationOf, metrics, instruction, seed });
  const assetId = id('ast');
  const row = {
    id: assetId,
    campaign_id: campaign.id,
    channel: spec.channel,
    format: spec.format,
    aspect_ratio: spec.aspect_ratio || CHANNELS[spec.channel].formats[spec.format],
    title: gen.title,
    headline: gen.headline,
    caption: gen.caption,
    cta: gen.cta,
    hashtags: gen.hashtags,
    content: gen.content,
    state: 'DRAFT',
    version,
    parent_id: parent?.id || null,
    auto_publish: true,
    generator: gen.generator,
  };
  if (spec.format === 'flyer') {
    const bg = await ctx.ai.generateImage({ workspace, asset: row });
    if (bg) row.content = { ...row.content, backgroundImage: bg };
  }
  row.utm_url = assetUtmUrl(row, campaign, workspace);
  row.score = scoreAsset(row, workspace);
  return row;
}

export async function generatePackage(ctx, campaignId, { channels, formats, includeLocked = false, instruction = '', genWorkspace = null } = {}) {
  const { db } = ctx;
  const campaign = must(db.byId('campaigns', campaignId), 'Campaign');
  const workspace = db.byId('workspaces', campaign.workspace_id);
  const specs = specsFor(channels?.length ? channels : campaign.channels, formats);
  if (!specs.length) throw new HttpError(400, 'No channel/format combinations selected');
  const existing = db.all('creative_assets', 'SELECT * FROM creative_assets WHERE campaign_id = ?', campaignId);
  const result = { created: [], replaced: [], skippedLocked: [] };
  for (const spec of specs) {
    const same = existing.filter((a) => a.channel === spec.channel && a.format === spec.format);
    const replaceable = same.filter((a) => REPLACEABLE_STATES.has(a.state));
    const locked = same.filter((a) => !REPLACEABLE_STATES.has(a.state));
    if (replaceable.length) {
      for (const a of replaceable) {
        const fresh = await buildAsset(ctx, { campaign, workspace, spec, version: a.version + 1, instruction, genWorkspace });
        const { id: _drop, state: _s, campaign_id: _c, ...content } = fresh;
        content.utm_url = assetUtmUrl({ ...a, version: a.version + 1 }, campaign, workspace);
        db.update('creative_assets', a.id, { ...content, state: a.state === 'NEEDS_REVISION' ? 'NEEDS_REVISION' : 'DRAFT' });
        result.replaced.push(a.id);
      }
    } else if (locked.length && !includeLocked) {
      result.skippedLocked.push(...locked.map((a) => a.id));
    } else {
      const row = await buildAsset(ctx, { campaign, workspace, spec, instruction, genWorkspace });
      db.insert('creative_assets', row);
      db.insert('asset_events', { id: id('evt'), asset_id: row.id, from_state: null, to_state: 'DRAFT', actor: 'generator', note: row.generator, at: nowIso() });
      result.created.push(row.id);
    }
  }
  return result;
}

/** Regenerate one asset. Unlocked → in place (version+1). Locked → a new draft variant; the approved item is untouched. */
export async function regenerateAsset(ctx, assetId, { instruction = '' } = {}) {
  const { db } = ctx;
  const asset = must(db.byId('creative_assets', assetId), 'Asset');
  const campaign = db.byId('campaigns', asset.campaign_id);
  const workspace = db.byId('workspaces', campaign.workspace_id);
  const spec = { channel: asset.channel, format: asset.format, aspect_ratio: asset.aspect_ratio };
  if (LOCKED_STATES.has(asset.state) || asset.state === 'FAILED') {
    const row = await buildAsset(ctx, { campaign, workspace, spec, version: 1, parent: asset, instruction, seed: `alt-${Date.now()}` });
    db.insert('creative_assets', row);
    db.insert('asset_events', { id: id('evt'), asset_id: row.id, from_state: null, to_state: 'DRAFT', actor: 'generator', note: `Alternative to locked ${asset.id}`, at: nowIso() });
    return { mode: 'variant', asset: db.byId('creative_assets', row.id), original: asset };
  }
  const fresh = await buildAsset(ctx, { campaign, workspace, spec, version: asset.version + 1, instruction });
  const { id: _i, state: _s, campaign_id: _c, parent_id: _p, ...content } = fresh;
  content.utm_url = assetUtmUrl({ ...asset, version: asset.version + 1 }, campaign, workspace);
  const updated = db.update('creative_assets', asset.id, { ...content, state: asset.state === 'NEEDS_REVIEW' ? 'DRAFT' : asset.state });
  if (asset.state === 'NEEDS_REVIEW') db.insert('asset_events', { id: id('evt'), asset_id: asset.id, from_state: 'NEEDS_REVIEW', to_state: 'DRAFT', actor: 'generator', note: 'Regenerated — resubmit for review', at: nowIso() });
  return { mode: 'in_place', asset: updated };
}

const EDITABLE = ['title', 'headline', 'caption', 'cta', 'hashtags', 'content'];
/** Inline edit. Editing approved/scheduled content sends it back to review so nothing unapproved can auto-post. */
export function editAsset({ db }, assetId, patch = {}) {
  const asset = must(db.byId('creative_assets', assetId), 'Asset');
  if (asset.state === 'PUBLISHED') throw new HttpError(409, 'Published creatives are immutable — regenerate to create a variation');
  const out = {};
  for (const k of EDITABLE) if (k in patch) out[k] = patch[k];
  if ('auto_publish' in patch) out.auto_publish = !!patch.auto_publish;
  if (typeof out.hashtags === 'string') out.hashtags = out.hashtags.split(/[\s,]+/).filter(Boolean).map((h) => '#' + h.replace(/^#/, ''));
  if (out.content) out.content = stripLinkTokens({ ...asset.content, ...out.content });
  const contentChanged = EDITABLE.some((k) => k in out && JSON.stringify(out[k]) !== JSON.stringify(asset[k]));
  const campaign = db.byId('campaigns', asset.campaign_id);
  const workspace = db.byId('workspaces', campaign.workspace_id);
  return db.tx(() => {
    if (contentChanged) out.score = scoreAsset({ ...asset, ...out }, workspace);
    let updated = db.update('creative_assets', asset.id, out);
    if (contentChanged && ['APPROVED', 'SCHEDULED', 'FAILED'].includes(asset.state)) {
      if (asset.state === 'SCHEDULED') cancelJobs(db, asset.id, 'Content edited after scheduling');
      updated = transition(db, updated, 'NEEDS_REVIEW', { actor: 'user', note: 'Edited after approval — needs re-approval', patch: { scheduled_at: null } });
    }
    return updated;
  });
}

function cancelJobs(db, assetId, reason) {
  for (const j of db.all('schedule_jobs', `SELECT * FROM schedule_jobs WHERE asset_id = ? AND status IN ('pending','retry','manual_required')`, assetId)) {
    db.update('schedule_jobs', j.id, { status: 'cancelled', log: [...j.log, { at: nowIso(), level: 'info', msg: `Cancelled: ${reason}` }] });
  }
}

export function transitionAsset({ db }, assetId, to, { note } = {}) {
  const asset = must(db.byId('creative_assets', assetId), 'Asset');
  if (to === 'SCHEDULED') throw new HttpError(400, 'Use POST /api/assets/:id/schedule to schedule');
  if (to === 'PUBLISHED') throw new HttpError(400, 'Use POST /api/assets/:id/mark-published (Share Kit) — auto-publishing is done by the scheduler');
  if (to === 'NEEDS_REVISION' && !note) throw new HttpError(400, 'Tell the creator what to change');
  return db.tx(() => {
    if (asset.state === 'SCHEDULED') cancelJobs(db, asset.id, `Moved to ${to}`);
    return transition(db, asset, to, { actor: 'user', note, patch: asset.state === 'SCHEDULED' ? { scheduled_at: null } : {} });
  });
}

export function submitDrafts({ db }, campaignId) {
  const drafts = db.all('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND state = 'DRAFT'`, campaignId);
  db.tx(() => drafts.forEach((a) => transition(db, a, 'NEEDS_REVIEW', { actor: 'user', note: 'Bulk submit' })));
  return { submitted: drafts.length };
}

export function scheduleAsset({ db }, assetId, { runAt, autoPublish } = {}) {
  const asset = must(db.byId('creative_assets', assetId), 'Asset');
  const when = new Date(runAt || Date.now());
  if (Number.isNaN(when.getTime())) throw new HttpError(400, 'Invalid publish time');
  if (!['APPROVED', 'FAILED', 'SCHEDULED'].includes(asset.state)) throw new HttpError(409, `Only APPROVED items can be scheduled (this one is ${asset.state})`);
  const campaign = db.byId('campaigns', asset.campaign_id);
  const conn = connectionFor(db, campaign.workspace_id, asset.channel);
  return db.tx(() => {
    cancelJobs(db, asset.id, 'Rescheduled');
    const auto = autoPublish === undefined ? asset.auto_publish : !!autoPublish;
    let updated;
    if (asset.state === 'SCHEDULED') {
      // Reschedule: content and approval are unchanged, only the time moves.
      updated = db.update('creative_assets', asset.id, { scheduled_at: when.toISOString(), auto_publish: auto });
      db.insert('asset_events', { id: id('evt'), asset_id: asset.id, from_state: 'SCHEDULED', to_state: 'SCHEDULED', actor: 'user', note: `Rescheduled to ${when.toISOString()}`, at: nowIso() });
    } else updated = transition(db, asset, 'SCHEDULED', { actor: 'user', note: `For ${when.toISOString()}`, patch: { scheduled_at: when.toISOString(), auto_publish: auto, error: null } });
    const willAuto = auto && conn?.mode === 'api' && conn.auto_publish && conn.status !== 'disconnected';
    db.insert('schedule_jobs', {
      id: id('job'),
      asset_id: asset.id,
      channel: asset.channel,
      run_at: when.toISOString(),
      status: 'pending',
      log: [{ at: nowIso(), level: 'info', msg: `Queued for ${when.toISOString()} — ${willAuto ? 'will auto-publish via API' : 'will prompt for Share Kit publishing'}` }],
    });
    return updated;
  });
}

export function unscheduleAsset(ctx, assetId) {
  return transitionAsset(ctx, assetId, 'APPROVED', { note: 'Unscheduled' });
}

/** User confirms they posted a Share Kit item manually. */
export function markPublished({ db }, assetId, { url } = {}) {
  const asset = must(db.byId('creative_assets', assetId), 'Asset');
  if (asset.state !== 'SCHEDULED') throw new HttpError(409, 'Only scheduled items can be marked as published — approve and schedule it first');
  return db.tx(() => {
    for (const j of db.all('schedule_jobs', `SELECT * FROM schedule_jobs WHERE asset_id = ? AND status IN ('pending','retry','manual_required')`, asset.id)) {
      db.update('schedule_jobs', j.id, { status: 'done', log: [...j.log, { at: nowIso(), level: 'success', msg: 'Marked as published manually (Share Kit)' }] });
    }
    db.run(`UPDATE campaign_tasks SET done = 1, done_at = ?, updated_at = ? WHERE asset_id = ? AND category = 'Publishing' AND done = 0`, nowIso(), nowIso(), asset.id);
    const updated = transition(db, asset, 'PUBLISHED', { actor: 'share_kit', note: 'Posted manually via Share Kit', patch: { published_at: nowIso(), external_url: url || null } });
    afterPublish(db, updated);
    return updated;
  });
}

/** Post-publish iteration loop: schedule the 48h review task. */
export function afterPublish(db, asset) {
  const campaign = db.byId('campaigns', asset.campaign_id);
  ensureTask(db, campaign, {
    title: `Review performance & iterate: ${asset.title}`,
    description: 'Check impressions, clicks, shares and signups; if it leads, generate a follow-up variation from Analytics.',
    category: 'Analytics Review',
    role: 'Marketer',
    due_date: isoDate(addDays(new Date(), 2)),
    source: 'post_publish',
    asset_id: asset.id,
  });
}

// ============================================================ metrics, progress, iteration
export function addMetrics({ db }, assetId, m = {}, source = 'manual') {
  const asset = must(db.byId('creative_assets', assetId), 'Asset');
  const n = (v) => Math.max(0, Math.floor(Number(v) || 0));
  return db.insert('campaign_metrics', {
    id: id('met'),
    campaign_id: asset.campaign_id,
    asset_id: asset.id,
    channel: asset.channel,
    date: m.date || today(),
    impressions: n(m.impressions),
    clicks: n(m.clicks),
    shares: n(m.shares),
    signups: n(m.signups),
    source,
    created_at: nowIso(),
  });
}

export function assetMetrics(db, campaignId) {
  return db.all(
    null,
    `SELECT a.id, a.title, a.channel, a.format, a.state, a.published_at, a.parent_id,
            COALESCE(SUM(m.impressions),0) impressions, COALESCE(SUM(m.clicks),0) clicks,
            COALESCE(SUM(m.shares),0) shares, COALESCE(SUM(m.signups),0) signups,
            GROUP_CONCAT(DISTINCT m.source) sources
     FROM creative_assets a LEFT JOIN campaign_metrics m ON m.asset_id = a.id
     WHERE a.campaign_id = ? AND a.state = 'PUBLISHED' GROUP BY a.id`,
    campaignId,
  ).map((r) => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0, cvr: r.clicks ? r.signups / r.clicks : 0, perf: r.signups * 10 + r.clicks + r.shares * 3 }));
}

export function progress({ db }, campaignId) {
  const campaign = must(db.byId('campaigns', campaignId), 'Campaign');
  const tasks = db.all('campaign_tasks', 'SELECT * FROM campaign_tasks WHERE campaign_id = ? ORDER BY due_date, sort', campaignId);
  const assets = db.all('creative_assets', 'SELECT id, title, channel, format, state, scheduled_at, published_at, parent_id FROM creative_assets WHERE campaign_id = ?', campaignId);
  const t0 = today();
  const done = tasks.filter((t) => t.done).length;
  const byCategory = Object.fromEntries(TASK_CATEGORIES.map((c) => [c, { total: 0, done: 0 }]));
  tasks.forEach((t) => {
    byCategory[t.category].total++;
    if (t.done) byCategory[t.category].done++;
  });
  const states = Object.fromEntries(['DRAFT', 'NEEDS_REVIEW', 'NEEDS_REVISION', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED'].map((s) => [s, 0]));
  assets.forEach((a) => states[a.state]++);
  const ready = states.APPROVED + states.SCHEDULED + states.PUBLISHED;
  const conns = db.all('channel_connections', 'SELECT * FROM channel_connections WHERE workspace_id = ?', campaign.workspace_id);
  const channels = campaign.channels.map((ch) => {
    const mine = assets.filter((a) => a.channel === ch);
    const c = conns.find((x) => x.channel === ch);
    return { channel: ch, label: CHANNELS[ch].label, mode: c?.mode, status: c?.status, auto_publish: c?.auto_publish, total: mine.length, ready: mine.filter((a) => ['APPROVED', 'SCHEDULED', 'PUBLISHED'].includes(a.state)).length, published: mine.filter((a) => a.state === 'PUBLISHED').length };
  });
  const jobs = db.all(
    'schedule_jobs',
    `SELECT j.*, a.title asset_title FROM schedule_jobs j JOIN creative_assets a ON a.id = j.asset_id WHERE a.campaign_id = ? ORDER BY j.updated_at DESC LIMIT 40`,
    campaignId,
  );
  const per = assetMetrics(db, campaignId);
  const totals = per.reduce((acc, r) => ({ impressions: acc.impressions + r.impressions, clicks: acc.clicks + r.clicks, shares: acc.shares + r.shares, signups: acc.signups + r.signups }), { impressions: 0, clicks: 0, shares: 0, signups: 0 });
  const conversions = db.all(null, `SELECT COALESCE(channel,'unattributed') channel, SUM(signups) signups FROM campaign_metrics WHERE campaign_id = ? AND source = 'webhook' GROUP BY channel`, campaignId);
  const top = [...per].sort((a, b) => b.perf - a.perf);
  const iterated = new Set(assets.filter((a) => a.parent_id).map((a) => a.parent_id));
  const candidate = top.find((r) => r.impressions > 0 && !iterated.has(r.id));
  return {
    campaign,
    launchInDays: Math.round((new Date(campaign.launch_date) - new Date(t0)) / 86_400_000),
    tasks: {
      total: tasks.length,
      done,
      remaining: tasks.length - done,
      pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
      overdue: tasks.filter((t) => !t.done && t.due_date < t0),
      upcoming: tasks.filter((t) => !t.done && t.due_date >= t0).slice(0, 6),
      byCategory,
    },
    assets: { total: assets.length, states, ready, readinessPct: assets.length ? Math.round((ready / assets.length) * 100) : 0 },
    channels,
    nextScheduled: db.all(
      null,
      `SELECT j.id, j.run_at, j.channel, j.status, a.title, a.id asset_id, a.auto_publish FROM schedule_jobs j JOIN creative_assets a ON a.id = j.asset_id WHERE a.campaign_id = ? AND j.status IN ('pending','retry','manual_required') ORDER BY j.run_at LIMIT 6`,
      campaignId,
    ),
    activity: jobs.flatMap((j) => j.log.map((l) => ({ ...l, job: j.id, asset: j.asset_title, channel: j.channel }))).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 14),
    metrics: { totals, ctr: totals.impressions ? totals.clicks / totals.impressions : 0, perAsset: top, conversions },
    iterationPrompt: candidate ? { assetId: candidate.id, title: candidate.title, clicks: candidate.clicks, signups: candidate.signups, ctr: candidate.ctr } : null,
  };
}

export async function iterateOnTopPerformer(ctx, campaignId, { assetId } = {}) {
  const { db } = ctx;
  const campaign = must(db.byId('campaigns', campaignId), 'Campaign');
  const per = assetMetrics(db, campaignId).sort((a, b) => b.perf - a.perf);
  const target = assetId ? per.find((r) => r.id === assetId) : per[0];
  if (!target) throw new HttpError(409, 'No published creatives with metrics yet — publish something first');
  const parent = db.byId('creative_assets', target.id);
  const workspace = db.byId('workspaces', campaign.workspace_id);
  const row = await buildAsset(ctx, {
    campaign,
    workspace,
    spec: { channel: parent.channel, format: parent.format, aspect_ratio: parent.aspect_ratio },
    parent,
    variationOf: parent,
    metrics: { impressions: target.impressions, clicks: target.clicks, shares: target.shares, signups: target.signups, ctr: target.ctr },
  });
  db.insert('creative_assets', row);
  db.insert('asset_events', { id: id('evt'), asset_id: row.id, from_state: null, to_state: 'DRAFT', actor: 'generator', note: `Iteration of top performer ${parent.id}`, at: nowIso() });
  db.run(`UPDATE campaign_tasks SET done = 1, done_at = ?, updated_at = ? WHERE asset_id = ? AND source = 'post_publish' AND done = 0`, nowIso(), nowIso(), parent.id);
  ensureTask(db, campaign, { title: `Review follow-up variation: ${row.title}`, category: 'Creative Review', role: 'Marketer', due_date: today(), source: 'post_publish', asset_id: row.id });
  return db.byId('creative_assets', row.id);
}

// ============================================================ webhooks
const TOLERANCE_S = 300;
export function signPayload(secret, rawBody, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
export function verifySignature(secret, header, rawBody, now = Date.now()) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')));
  if (!parts.t || !parts.v1) throw new HttpError(401, 'Missing X-LaunchLoop-Signature (format: t=<unix>,v1=<hex hmac>)');
  if (Math.abs(now / 1000 - Number(parts.t)) > TOLERANCE_S) throw new HttpError(401, 'Signature timestamp outside the 5-minute tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  if (!timingSafeEqualStr(expected, parts.v1)) throw new HttpError(401, 'Invalid signature');
}

/** Authenticate + idempotency. Returns { ws, payload, duplicate, eventId }. */
export function acceptWebhook({ db }, type, headers, rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  const wsId = payload.workspace_id || headers['x-launchloop-workspace'];
  const ws = wsId && db.byId('workspaces', wsId);
  if (!ws) throw new HttpError(401, 'Unknown workspace_id');
  verifySignature(ws.webhook_secret, headers['x-launchloop-signature'], rawBody);
  const eventId = String(headers['x-launchloop-event-id'] || payload.event_id || '');
  if (eventId) {
    const prev = db.get('webhook_events', 'SELECT * FROM webhook_events WHERE id = ?', `${ws.id}:${eventId}`);
    if (prev) return { ws, payload, duplicate: true, previous: prev.result, eventId };
  }
  return { ws, payload, duplicate: false, eventId };
}

export function recordWebhook({ db }, ws, type, eventId, payload, result) {
  const key = `${ws.id}:${eventId || id('evt')}`;
  const existing = db.get('webhook_events', 'SELECT id FROM webhook_events WHERE id = ?', key);
  if (existing) db.run('UPDATE webhook_events SET result = ? WHERE id = ?', JSON.stringify(result), key);
  else db.insert('webhook_events', { id: key, workspace_id: ws.id, type, payload, result, received_at: nowIso() });
}

/** product-update → new campaign with DRAFT creatives (never auto-approved) + tasks. Generation continues in background. */
export async function handleProductUpdate(ctx, ws, payload) {
  const { db } = ctx;
  if (!payload.title) throw new HttpError(400, 'title is required');
  const newFeatures = (payload.features || []).map((f) => (typeof f === 'string' ? { name: f.split(/\s+/).slice(0, 4).join(' '), benefit: f } : f)).filter((f) => f?.name);
  if (newFeatures.length) {
    const names = new Set(newFeatures.map((f) => f.name.toLowerCase()));
    updateWorkspace(ctx, ws.id, { features: [...newFeatures, ...ws.features.filter((f) => !names.has(String(f.name).toLowerCase()))].slice(0, 10) });
  }
  const last = db.get('campaigns', `SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1`, ws.id);
  const channels = (payload.channels || last?.channels || ['linkedin', 'x', 'instagram']).filter((c) => CHANNELS[c]);
  const campaign = await createCampaign(ctx, ws.id, {
    name: `${payload.title}`,
    goal: payload.summary ? `Announce: ${payload.summary}` : 'Announce product update',
    launch_date: payload.launch_date || isoDate(addDays(new Date(), 7)),
    channels,
    base_url: payload.url || ws.website_url,
    source: `webhook:${payload.event || 'product_update'}`,
  });
  const genWorkspace = { ...db.byId('workspaces', ws.id), features: newFeatures.length ? newFeatures : ws.features, tagline: payload.summary || ws.tagline };
  const job = generatePackage(ctx, campaign.id, { formats: payload.formats, genWorkspace, instruction: `Announce update: ${payload.title}. ${payload.summary || ''}` });
  return { campaign, job };
}

export function handleConversion({ db }, ws, p) {
  let utm = { source: p.utm_source, medium: p.utm_medium, campaign: p.utm_campaign, content: p.utm_content };
  if (p.landing_url) {
    try {
      const u = new URL(p.landing_url);
      utm = { source: utm.source || u.searchParams.get('utm_source'), medium: utm.medium || u.searchParams.get('utm_medium'), campaign: utm.campaign || u.searchParams.get('utm_campaign'), content: utm.content || u.searchParams.get('utm_content') };
    } catch {}
  }
  const parsed = parseUtmContent(utm.content);
  let asset = parsed && db.byId('creative_assets', parsed.assetId);
  let campaign = asset && db.byId('campaigns', asset.campaign_id);
  if (campaign && campaign.workspace_id !== ws.id) (asset = null), (campaign = null);
  if (!campaign && utm.campaign) campaign = db.get('campaigns', 'SELECT * FROM campaigns WHERE workspace_id = ? AND utm_campaign = ? ORDER BY created_at DESC', ws.id, utm.campaign);
  if (!campaign) return { attributed: false, reason: 'No campaign matched utm_campaign / utm_content' };
  const count = Math.max(1, Math.floor(Number(p.quantity) || 1));
  db.insert('campaign_metrics', {
    id: id('met'),
    campaign_id: campaign.id,
    asset_id: asset?.id || null,
    channel: asset?.channel || utm.source || null,
    date: isoDate(p.occurred_at ? new Date(p.occurred_at) : new Date()),
    impressions: 0,
    clicks: 0,
    shares: p.event === 'referral' ? count : 0,
    signups: count,
    source: 'webhook',
    created_at: nowIso(),
  });
  return { attributed: !!asset, campaignId: campaign.id, assetId: asset?.id || null, channel: asset?.channel || utm.source || null, event: p.event || 'signup' };
}

// ============================================================ share kit
export function shareKit({ db, config }, assetId) {
  const asset = must(db.byId('creative_assets', assetId), 'Asset');
  const ch = CHANNELS[asset.channel];
  const campaign = db.byId('campaigns', asset.campaign_id);
  const conn = connectionFor(db, campaign.workspace_id, asset.channel);
  const link = asset.utm_url || '';
  const caption = String(asset.caption || '').replace(/\{\{link\}\}/g, link);
  const withTags = asset.hashtags?.length ? `${caption}\n\n${asset.hashtags.join(' ')}` : caption;
  const base = `/api/assets/${asset.id}`;
  const media =
    asset.format === 'carousel'
      ? (asset.content.slides || []).map((_, i) => ({ label: `Slide ${i + 1}`, svg: `${base}/media.svg?slide=${i}`, aspect: asset.aspect_ratio }))
      : [{ label: asset.format === 'reel' || asset.format === 'video' ? 'Storyboard preview (animated)' : 'Image', svg: `${base}/media.svg`, aspect: asset.aspect_ratio }];
  const steps = {
    instagram: ['Open Instagram → + → Reel/Post', 'Upload the exported media (keep the aspect ratio)', 'Paste the caption; put the tracked link in your bio / link sticker', 'Share to Story with a link sticker for extra reach'],
    tiktok: ['Render the video from the render job (or film it following the storyboard)', 'Upload in TikTok, add on-screen text from the script', 'Paste the caption; link in bio', 'Pin a comment with the share prompt'],
    reddit: ['Read the subreddit rules on self-promotion first', 'Create a text post using the copy (be transparent you are the maker)', 'Add the tracked link once, at the end', 'Reply to every comment for the first 2 hours'],
    whatsapp_status: ['Download the vertical media (PNG for flyers, MP4 via “Download video” for reels)', 'Send it to your phone (e.g. WhatsApp yourself or AirDrop/Drive)', 'Open WhatsApp → Updates → My status → add the media', 'Paste the short caption — the tracked link stays clickable', 'Reply to everyone who responds to the status'],
    whatsapp: ['Download the square image (PNG)', 'Open your WhatsApp Channel (or a group where promotion is welcome)', 'Attach the image and paste the message as its caption', 'Ask a few friends to forward it — the message is written to be forwarded', 'Answer replies quickly; never add people to groups without their consent'],
    telegram: ['Open your Telegram channel', 'Paste the post (keep the link on its own line so Telegram shows the preview)', 'Optionally attach the image or video', 'Pin it if it is your launch post', 'Reply in the comments/discussion group'],
    product_hunt: ['Upload gallery images (1270×760 works well; exports are 16:9)', 'Paste the tagline and first comment', 'Add the tracked link as the website URL', 'Share the PH link with your community at launch'],
  }[asset.channel] || ['Open the platform composer', 'Upload the exported media', 'Paste the caption (tracked link included)', 'Post, then click “Mark as published” here'];
  return {
    assetId: asset.id,
    channel: asset.channel,
    channelLabel: ch.label,
    mode: conn?.mode,
    requirements: ch.requirements,
    caption: withTags,
    captionLength: withTags.length,
    captionLimit: ch.captionLimit,
    overLimit: withTags.length > ch.captionLimit,
    link,
    hashtags: asset.hashtags,
    media,
    renderJob: asset.format === 'reel' || asset.format === 'video' ? `${base}/render-job` : null,
    checklist: [...steps, 'Click “Mark as published” so the timeline and analytics update'],
    publicBaseUrl: config.publicBaseUrl,
  };
}
