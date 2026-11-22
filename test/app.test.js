import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { openDb } from '../src/db.js';
import { config as makeConfig } from '../src/lib/env.js';
import { AIService } from '../src/services/ai.js';
import * as core from '../src/services/core.js';
import { robotsAllows, extractFromHtml } from '../src/services/ingest.js';
import { renderAssetSvg, buildRenderJob } from '../src/services/media.js';
import { Publisher } from '../src/services/publisher.js';
import { canTransition } from '../src/services/stateMachine.js';
import { buildUtmUrl, parseUtmContent, utmContentFor } from '../src/services/utm.js';
import { seed } from '../src/seed.js';
import { createWorker } from '../src/worker.js';
import { start } from '../src/server.js';
import { execFileSync as execFileSyncTop } from 'node:child_process';
import { Notifier } from '../src/services/notify.js';
import { planSchedule, applySchedule, bulkTransition, zonedToUtc } from '../src/services/scheduling.js';

const mkCtx = () => {
  const config = makeConfig({ PUBLISH_MODE: 'mock', SIMULATE_METRICS: 'false' });
  return { db: openDb(':memory:'), ai: new AIService({ AI_PROVIDER: 'mock' }), config };
};
async function setup() {
  const ctx = mkCtx();
  const { workspace, campaign } = await seed(ctx);
  return { ctx, workspace, campaign };
}
const assetsIn = (db, campaignId, state) => db.all('creative_assets', 'SELECT * FROM creative_assets WHERE campaign_id = ? AND state = ?', campaignId, state);

describe('approval state machine', () => {
  test('only APPROVED (or FAILED retry) can be scheduled; only worker/share_kit publish', () => {
    assert.equal(canTransition('DRAFT', 'SCHEDULED'), false);
    assert.equal(canTransition('NEEDS_REVIEW', 'SCHEDULED'), false);
    assert.equal(canTransition('APPROVED', 'SCHEDULED'), true);
    assert.equal(canTransition('SCHEDULED', 'PUBLISHED', 'user'), false);
    assert.equal(canTransition('SCHEDULED', 'PUBLISHED', 'worker'), true);
    assert.equal(canTransition('SCHEDULED', 'FAILED', 'user'), false);
    assert.equal(canTransition('PUBLISHED', 'DRAFT'), false);
  });

  test('scheduling a non-approved asset is rejected', async () => {
    const { ctx, campaign } = await setup();
    const draft = assetsIn(ctx.db, campaign.id, 'DRAFT')[0];
    assert.throws(() => core.scheduleAsset(ctx, draft.id, { runAt: new Date().toISOString() }), /Only APPROVED/);
  });

  test('editing a scheduled asset cancels its job and sends it back to review', async () => {
    const { ctx, campaign } = await setup();
    const s = assetsIn(ctx.db, campaign.id, 'SCHEDULED')[0];
    const updated = core.editAsset(ctx, s.id, { caption: 'changed {{link}}' });
    assert.equal(updated.state, 'NEEDS_REVIEW');
    const jobs = ctx.db.all('schedule_jobs', 'SELECT * FROM schedule_jobs WHERE asset_id = ?', s.id);
    assert.ok(jobs.every((j) => j.status === 'cancelled'));
  });
});

describe('generation & regeneration', () => {
  test('package regeneration never overwrites approved/scheduled/published items', async () => {
    const { ctx, campaign } = await setup();
    const lockedBefore = ctx.db.all('creative_assets', `SELECT id, caption, version FROM creative_assets WHERE campaign_id = ? AND state IN ('APPROVED','SCHEDULED','PUBLISHED')`, campaign.id);
    const r = await core.generatePackage(ctx, campaign.id, {});
    assert.ok(r.skippedLocked.length >= lockedBefore.length);
    for (const a of lockedBefore) {
      const now = ctx.db.byId('creative_assets', a.id);
      assert.equal(now.caption, a.caption);
      assert.equal(now.version, a.version);
    }
  });

  test('regenerating an approved asset creates a new draft variant', async () => {
    const { ctx, campaign } = await setup();
    const approved = assetsIn(ctx.db, campaign.id, 'APPROVED')[0];
    const r = await core.regenerateAsset(ctx, approved.id);
    assert.equal(r.mode, 'variant');
    assert.equal(r.asset.state, 'DRAFT');
    assert.equal(r.asset.parent_id, approved.id);
    assert.equal(ctx.db.byId('creative_assets', approved.id).state, 'APPROVED');
  });

  test('every asset has a complete shape, tracked link and score', async () => {
    const { ctx, campaign } = await setup();
    for (const a of ctx.db.all('creative_assets', 'SELECT * FROM creative_assets WHERE campaign_id = ?', campaign.id)) {
      assert.ok(a.headline && a.caption && a.cta, a.id);
      assert.ok(a.utm_url.includes(`utm_content=${utmContentFor(a)}`), a.id);
      assert.ok(a.score.overall >= 0 && a.score.overall <= 100);
      if (a.format === 'reel' || a.format === 'video') assert.ok(a.content.storyboard.length >= 4 && a.content.script.hook);
      if (a.format === 'carousel') assert.ok(a.content.slides.length >= 5);
      const svg = renderAssetSvg(a, ctx.db.byId('workspaces', campaign.workspace_id));
      assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
    }
  });

  test('render job is renderer-agnostic and timed', async () => {
    const { ctx, campaign } = await setup();
    const reel = ctx.db.get('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND format = 'reel'`, campaign.id);
    const job = buildRenderJob(reel, ctx.db.byId('workspaces', campaign.workspace_id));
    assert.equal(job.composition.width, 1080);
    assert.equal(job.composition.height, 1920);
    assert.equal(job.scenes[0].start, 0);
    assert.equal(job.scenes.at(-1).end, job.composition.durationSec);
  });
});

describe('scheduler worker', () => {
  test('publishes due API items, routes Share Kit items to a task, retries then fails', async () => {
    const { ctx, campaign } = await setup();
    const { db } = ctx;
    db.run(`UPDATE schedule_jobs SET run_at = ? WHERE status = 'pending'`, new Date(Date.now() - 1000).toISOString());
    db.run(`UPDATE schedule_jobs SET run_at = ? WHERE asset_id IN (SELECT id FROM creative_assets WHERE channel = 'linkedin')`, new Date(Date.now() + 86400000).toISOString());
    const okWorker = createWorker({ db, publisher: new Publisher({ mode: 'mock', failureRate: 0 }), config: ctx.config });
    await okWorker.tick();
    const ig = db.get('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND channel = 'instagram' AND format = 'post'`, campaign.id);
    assert.equal(ig.state, 'PUBLISHED');
    const tt = db.get('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND channel = 'tiktok' AND format = 'reel'`, campaign.id);
    assert.equal(tt.state, 'SCHEDULED');
    assert.equal(db.scalar(`SELECT status FROM schedule_jobs WHERE asset_id = ?`, tt.id), 'manual_required');
    assert.ok(db.scalar(`SELECT COUNT(*) FROM campaign_tasks WHERE asset_id = ? AND category = 'Publishing'`, tt.id) >= 1);
    // post-publish loop task
    assert.ok(db.scalar(`SELECT COUNT(*) FROM campaign_tasks WHERE asset_id = ? AND source = 'post_publish'`, ig.id) >= 1);

    // failing publisher: approve + schedule an X flyer and let it exhaust retries
    const xf = db.get('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND channel = 'x' AND format = 'flyer'`, campaign.id);
    core.scheduleAsset(ctx, xf.id, { runAt: new Date(Date.now() - 1000).toISOString() });
    const badWorker = createWorker({ db, publisher: new Publisher({ mode: 'mock', failureRate: 1 }), config: ctx.config });
    for (let i = 0; i < 3; i++) {
      await badWorker.tick();
      db.run(`UPDATE schedule_jobs SET run_at = ? WHERE asset_id = ? AND status = 'retry'`, new Date(Date.now() - 1000).toISOString(), xf.id);
    }
    assert.equal(db.byId('creative_assets', xf.id).state, 'FAILED');
  });

  test('worker never publishes an asset that is no longer SCHEDULED', async () => {
    const { ctx, campaign } = await setup();
    const { db } = ctx;
    const s = assetsIn(db, campaign.id, 'SCHEDULED').find((a) => a.channel === 'instagram');
    db.run(`UPDATE creative_assets SET state = 'NEEDS_REVIEW' WHERE id = ?`, s.id); // simulate a race
    db.run(`UPDATE schedule_jobs SET run_at = ? WHERE asset_id = ?`, new Date(Date.now() - 1000).toISOString(), s.id);
    await createWorker({ db, publisher: new Publisher({ mode: 'mock', failureRate: 0 }), config: ctx.config }).tick();
    assert.equal(db.byId('creative_assets', s.id).state, 'NEEDS_REVIEW');
    assert.equal(db.scalar('SELECT status FROM schedule_jobs WHERE asset_id = ?', s.id), 'cancelled');
  });
});

describe('UTM, webhooks, ingestion', () => {
  test('UTM builder replaces old utm params and keeps the rest', () => {
    const u = buildUtmUrl('https://a.com/p?x=1&utm_source=old#h', { source: 'LinkedIn', medium: 'social', campaign: 'Spring Launch', content: 'reel-abc123abc123-v2' });
    assert.equal(u, 'https://a.com/p?x=1&utm_source=linkedin&utm_medium=social&utm_campaign=spring_launch&utm_content=reel-abc123abc123-v2#h');
    assert.deepEqual(parseUtmContent('reel-abc123abc123-v2'), { format: 'reel', assetId: 'ast_abc123abc123', version: 2 });
  });

  test('webhook signature verification', () => {
    const body = '{"a":1}';
    const sig = core.signPayload('s3cret', body);
    assert.doesNotThrow(() => core.verifySignature('s3cret', sig, body));
    assert.throws(() => core.verifySignature('wrong', sig, body), /Invalid signature/);
    assert.throws(() => core.verifySignature('s3cret', core.signPayload('s3cret', body, 1000), body), /tolerance/);
  });

  test('conversion is attributed to the creative from utm_content', async () => {
    const { ctx, workspace, campaign } = await setup();
    const pub = assetsIn(ctx.db, campaign.id, 'PUBLISHED')[0];
    const r = core.handleConversion(ctx, workspace, { event: 'signup', landing_url: pub.utm_url });
    assert.equal(r.attributed, true);
    assert.equal(r.assetId, pub.id);
  });

  test('robots.txt evaluation', () => {
    const robots = 'User-agent: *\nDisallow: /admin\nAllow: /admin/public\n\nUser-agent: LaunchLoopBot\nDisallow: /private';
    assert.equal(robotsAllows(robots, '/'), true);
    assert.equal(robotsAllows(robots, '/private/x'), false);
    assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/pricing'), false);
    assert.equal(robotsAllows('User-agent: *\nDisallow: /admin\nAllow: /admin/public', '/admin/public/x'), true);
  });

  test('HTML extraction + mock analysis', async () => {
    const ex = extractFromHtml('<html><head><title>Shipnote | Release notes</title><meta name="description" content="Release notes your users read."></head><body><h1>Release notes on autopilot</h1><ul><li>Changelog widget — embeds in your app in 2 minutes</li><li>AI summaries — turns commits into plain English</li></ul><p>$19/mo</p></body></html>');
    assert.equal(ex.title, 'Shipnote | Release notes');
    assert.equal(ex.prices[0], '$19/mo');
    const a = await new AIService({ AI_PROVIDER: 'mock' }).analyzeProduct({ url: 'https://shipnote.example', extracted: ex });
    assert.equal(a.name, 'Shipnote');
    assert.equal(a.features[0].name, 'Changelog widget');
  });
});

describe('HTTP API', () => {
  let srv;
  let base;
  before(async () => {
    srv = await start({ port: 0, dbFile: ':memory:', worker: false });
    base = `http://localhost:${srv.port}`;
  });
  after(() => srv.server.close());

  test('health, progress, signed product-update webhook', async () => {
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.ok, true);
    const [ws] = await (await fetch(`${base}/api/workspaces`)).json();
    const full = await (await fetch(`${base}/api/workspaces/${ws.id}`)).json();
    const [cmp] = await (await fetch(`${base}/api/workspaces/${ws.id}/campaigns`)).json();
    const p = await (await fetch(`${base}/api/campaigns/${cmp.id}/progress`)).json();
    assert.ok(p.tasks.total > 10 && p.assets.total > 10);

    const raw = JSON.stringify({ workspace_id: ws.id, title: 'Weekly AI digest', features: ['AI digest: summarises a week of standups'] });
    const unsigned = await fetch(`${base}/api/webhooks/product-update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal(unsigned.status, 401);
    const headers = { 'content-type': 'application/json', 'x-launchloop-signature': core.signPayload(full.webhook_secret, raw), 'x-launchloop-event-id': 'evt-1' };
    const res = await fetch(`${base}/api/webhooks/product-update`, { method: 'POST', headers, body: raw });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.ok(body.campaignId);
    const dup = await (await fetch(`${base}/api/webhooks/product-update`, { method: 'POST', headers, body: raw })).json();
    assert.equal(dup.duplicate, true);
    await new Promise((r) => setTimeout(r, 300));
    const assets = await (await fetch(`${base}/api/campaigns/${body.campaignId}/assets`)).json();
    assert.ok(assets.length > 0 && assets.every((a) => a.state === 'DRAFT'), 'webhook drafts are never auto-approved');
  });
});

describe('reminders (email + WhatsApp)', () => {
  async function setupNotifier({ fail = false } = {}) {
    const { ctx, workspace, campaign } = await setup();
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body), headers: opts.headers });
      if (fail) return new Response(JSON.stringify({ error: { message: 'Invalid token' } }), { status: 401 });
      return new Response(JSON.stringify(url.includes('resend') ? { id: 'em_1' } : { messages: [{ id: 'wamid.1' }] }), { status: 200 });
    };
    const config = { ...ctx.config, publicBaseUrl: 'https://applaunchloop.com', env: { RESEND_API_KEY: 're_x', NOTIFY_EMAIL_FROM: 'LaunchLoop <reminders@applaunchloop.com>', WHATSAPP_TOKEN: 'wa_x', WHATSAPP_PHONE_NUMBER_ID: '123' } };
    const n = new Notifier({ db: ctx.db, config, fetchImpl });
    n.saveSettings(workspace, { email: 'gene@example.com', whatsapp: '+233 24 123 4567', timezone: 'Africa/Accra', digestTime: '08:00' });
    return { ctx, workspace, campaign, n, calls };
  }

  test('post-due reminder goes to both channels once, with a Share Kit link', async () => {
    const { ctx, campaign, n, calls } = await setupNotifier();
    const asset = ctx.db.get('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND channel = 'tiktok'`, campaign.id);
    await n.postDue(asset);
    await n.postDue(asset); // duplicate trigger
    assert.equal(calls.length, 2);
    const email = calls.find((c) => c.url.includes('resend'));
    const wa = calls.find((c) => c.url.includes('graph.facebook.com'));
    assert.deepEqual(email.body.to, ['gene@example.com']);
    assert.match(email.body.html, /#\/review\?kit=ast_/);
    assert.equal(wa.body.to, '233241234567');
    assert.equal(wa.body.template.name, 'launchloop_reminder');
    for (const p of wa.body.template.components[0].parameters) assert.doesNotMatch(p.text, /\n|\t| {4,}/);
  });

  test('failures are logged, not thrown', async () => {
    const { ctx, workspace, campaign, n } = await setupNotifier({ fail: true });
    const asset = ctx.db.get('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND state = 'FAILED'`, campaign.id);
    const r = await n.publishFailed(asset, 'boom');
    assert.ok(r.every((x) => x.status === 'failed' && /401/.test(x.error)));
    assert.equal(n.log(workspace).length, 2);
  });

  test('daily digest is sent once, only after the chosen local time', async () => {
    const { n, calls } = await setupNotifier();
    const day = new Date().toISOString().slice(0, 10);
    await n.digestTick(new Date(`${day}T07:30:00Z`)); // 07:30 in Accra (UTC+0) — too early
    assert.equal(calls.length, 0);
    await n.digestTick(new Date(`${day}T08:05:00Z`));
    await n.digestTick(new Date(`${day}T09:00:00Z`));
    assert.equal(calls.length, 2); // email + WhatsApp, once
    assert.match(calls[0].body.subject, /LaunchLoop today/);
  });

  test('settings validation', async () => {
    const { workspace, n } = await setupNotifier();
    assert.throws(() => n.saveSettings(workspace, { whatsapp: '0241234' }), /country code/);
    assert.throws(() => n.saveSettings(workspace, { email: 'not-an-email' }), /valid email/);
    assert.equal(n.saveSettings(workspace, { whatsapp: '233241234567' }).whatsapp, '+233241234567');
  });
});

describe('bulk scheduling', () => {
  test('time-zone conversion', () => {
    assert.equal(zonedToUtc('2026-11-24', '19:00', 'Africa/Accra'), '2026-11-24T19:00:00.000Z');
    assert.equal(zonedToUtc('2026-11-24', '19:00', 'Africa/Lagos'), '2026-11-24T18:00:00.000Z');
    assert.equal(zonedToUtc('2026-07-01', '08:00', 'Europe/London'), '2026-07-01T07:00:00.000Z');
  });

  test('plan spreads posts one per channel per day, skips weekends for LinkedIn and busy days', async () => {
    const { ctx, campaign } = await setup();
    const { db } = ctx;
    // approve every draft / review item so there is plenty to schedule
    for (const a of db.all('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND state IN ('DRAFT','NEEDS_REVIEW')`, campaign.id)) {
      if (a.state === 'DRAFT') core.transitionAsset(ctx, a.id, 'NEEDS_REVIEW');
      core.transitionAsset(ctx, a.id, 'APPROVED');
    }
    const start = '2030-03-04'; // a Monday, far in the future
    const r = planSchedule(db, campaign.id, { startDate: start, endDate: '2030-03-31', timezone: 'Africa/Accra', now: new Date('2030-03-01T00:00:00Z') });
    assert.ok(r.plan.length > 0);
    assert.equal(r.unscheduled.length, 0);
    const perDay = {};
    for (const p of r.plan) {
      const k = `${p.channel}|${p.localDate}`;
      perDay[k] = (perDay[k] || 0) + 1;
      assert.equal(perDay[k], 1, `two ${p.channel} posts on ${p.localDate}`);
      if (p.channel === 'linkedin') assert.ok(![0, 6].includes(new Date(p.localDate + 'T12:00:00Z').getUTCDay()), 'LinkedIn on a weekend');
      assert.equal(p.runAt, zonedToUtc(p.localDate, p.localTime, 'Africa/Accra'));
    }
  });

  test('apply schedules the plan; reschedule keeps the approval and moves the job', async () => {
    const { ctx, campaign } = await setup();
    const { db } = ctx;
    const res = applySchedule(ctx, campaign.id, { startDate: '2030-03-04', endDate: '2030-03-20', timezone: 'Africa/Accra', now: new Date('2030-03-01T00:00:00Z') });
    assert.ok(res.scheduled.length >= 2 && res.errors.length === 0);
    const a = db.byId('creative_assets', res.scheduled[0].assetId);
    assert.equal(a.state, 'SCHEDULED');
    const moved = core.scheduleAsset(ctx, a.id, { runAt: '2030-03-25T10:00:00.000Z' });
    assert.equal(moved.state, 'SCHEDULED');
    assert.equal(moved.scheduled_at, '2030-03-25T10:00:00.000Z');
    const jobs = db.all('schedule_jobs', 'SELECT * FROM schedule_jobs WHERE asset_id = ? ORDER BY created_at', a.id);
    assert.equal(jobs.filter((j) => j.status === 'pending').length, 1);
    assert.equal(jobs.find((j) => j.status === 'pending').run_at, '2030-03-25T10:00:00.000Z');
  });

  test('bulk approve only touches the selected items in this campaign', async () => {
    const { ctx, campaign } = await setup();
    const review = ctx.db.all('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND state = 'NEEDS_REVIEW'`, campaign.id);
    const r = bulkTransition(ctx, campaign.id, { assetIds: [review[0].id, review[1].id, 'ast_000000000000'], to: 'APPROVED' });
    assert.equal(r.ok.length, 2);
    assert.equal(r.errors.length, 1);
    assert.equal(ctx.db.byId('creative_assets', review[2].id).state, 'NEEDS_REVIEW');
  });
});

describe('WhatsApp + Telegram channels', () => {
  test('existing workspaces get the new channel rows on startup', async () => {
    const { ctx, workspace } = await setup();
    ctx.db.run(`DELETE FROM channel_connections WHERE channel IN ('whatsapp','whatsapp_status','telegram')`);
    core.syncChannelStatuses(ctx);
    const rows = ctx.db.all('channel_connections', `SELECT * FROM channel_connections WHERE workspace_id = ? AND channel IN ('whatsapp','whatsapp_status','telegram')`, workspace.id);
    assert.equal(rows.length, 3);
    assert.equal(rows.find((r) => r.channel === 'whatsapp').mode, 'share_kit');
    assert.equal(rows.find((r) => r.channel === 'telegram').mode, 'api');
  });

  test('WhatsApp copy has no hashtags and a forward prompt; package generates for new channels', async () => {
    const { ctx, campaign } = await setup();
    const r = await core.generatePackage(ctx, campaign.id, { channels: ['whatsapp', 'whatsapp_status', 'telegram'] });
    assert.equal(r.created.length, 7);
    const wa = ctx.db.get('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND channel = 'whatsapp' AND format = 'post'`, campaign.id);
    assert.deepEqual(wa.hashtags, []);
    assert.match(wa.caption, /Forward this/);
    const st = ctx.db.get('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND channel = 'whatsapp_status' AND format = 'flyer'`, campaign.id);
    assert.equal(st.aspect_ratio, '9:16');
  });

  test('Telegram adapter posts text with the tracked link', async () => {
    const calls = [];
    const pub = new Publisher({ mode: 'live', env: { TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: '@pb' }, fetchImpl: async (url, o) => (calls.push([url, JSON.parse(o.body)]), new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }))) });
    const r = await pub.publish({ asset: { channel: 'telegram', caption: 'Hi {{link}}', utm_url: 'https://x.com/?utm_source=telegram', hashtags: [] }, connection: { mode: 'api', status: 'connected' } });
    assert.match(calls[0][0], /api\.telegram\.org\/bottok\/sendMessage/);
    assert.equal(calls[0][1].text, 'Hi https://x.com/?utm_source=telegram');
    assert.equal(r.url, 'https://t.me/pb/7');
  });
});

describe('video clips in the media library', () => {
  test('MOV upload is converted to H.264 MP4 with duration + poster, and resolves in scenes', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch {
      return; // ffmpeg not installed here — covered in the Docker image
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llv-'));
    const mov = path.join(dir, 'c.mov');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=2', '-c:v', 'mpeg4', mov]);
    const { addVideo, listMedia, resolveSceneMedia } = await import('../src/services/library.js');
    const { ctx, workspace } = await setup();
    const v = await addVideo(ctx.db, workspace, { buffer: fs.readFileSync(mov), mime: 'video/quicktime', name: 'c.mov', label: 'blocker radar demo', dataDir: dir });
    assert.equal(v.mime, 'video/mp4');
    assert.ok(Math.abs(v.duration - 2) < 0.2);
    assert.ok(v.posterUrl);
    const lib = listMedia(ctx.db, workspace);
    const r = resolveSceneMedia({ type: 'demo', onScreenText: 'Blocker radar', media: { id: v.id, start: 0.5 } }, 0, lib);
    assert.equal(r.item.kind, 'video');
    assert.equal(r.start, 0.5);
    assert.equal(r.zoom, false);
  });
});

describe('AI motion clips + uploaded finished videos', () => {
  const haveFfmpeg = () => {
    try {
      execFileSyncTop('ffmpeg', ['-version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  test('AI clip job stores the video and places it in the scene', async () => {
    if (!haveFfmpeg()) return;
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llg-'));
    const mp4 = path.join(dir, 'g.mp4');
    execFileSyncTop('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=24:duration=3', '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4]);
    const b64 = fs.readFileSync(mp4).toString('base64');
    const { VideoGen } = await import('../src/services/videogen.js');
    const { ctx, campaign } = await setup();
    let sent;
    const vg = new VideoGen({
      db: ctx.db,
      config: { ...ctx.config, dataDir: dir, env: { GEMINI_API_KEY: 'k' } },
      fetchImpl: async (url, o) => ((sent = JSON.parse(o.body)), new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: b64 }] }] }))),
    });
    let reel = ctx.db.get('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND channel = 'youtube_shorts' AND format = 'reel'`, campaign.id);
    reel = core.transitionAsset(ctx, reel.id, 'NEEDS_REVIEW', { note: 'add AI clips' });
    const ws = ctx.db.byId('workspaces', campaign.workspace_id);
    const [job] = vg.forScenes(reel, ws, { scenes: [0] });
    for (let i = 0; i < 100 && ctx.db.byId('ai_video_jobs', job.id).status !== 'done'; i++) await new Promise((r) => setTimeout(r, 100));
    const done = ctx.db.byId('ai_video_jobs', job.id);
    assert.equal(done.status, 'done', done.error);
    assert.equal(sent.model, 'gemini-omni-1.2-flash');
    assert.equal(sent.response_format.aspect_ratio, '9:16');
    assert.match(typeof sent.input === 'string' ? sent.input : '', /No on-screen text/);
    const after = ctx.db.byId('creative_assets', reel.id);
    assert.equal(after.content.storyboard[0].media.id, done.media_id);
  });

  test('finished video keeps its audio and becomes one draft per channel', async () => {
    if (!haveFfmpeg()) return;
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llf-'));
    const src = path.join(dir, 'final.mov');
    execFileSyncTop('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=540x960:rate=30:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:d=4', '-shortest', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', src]);
    const { addFinalVideo } = await import('../src/services/library.js');
    const { ctx, campaign } = await setup();
    const ws = ctx.db.byId('workspaces', campaign.workspace_id);
    const tmp = path.join(dir, 'upload.tmp');
    fs.copyFileSync(src, tmp);
    const m = await addFinalVideo(ctx.db, ws, { tmpPath: tmp, mime: 'video/quicktime', name: 'final.mov', label: 'Launch video', dataDir: dir });
    assert.equal(m.kind, 'final');
    const codecs = execFileSyncTop('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(dir, 'media', `${m.id}.mp4`)]).toString();
    assert.match(codecs, /h264/);
    assert.match(codecs, /aac/, 'audio kept');
    const r = await core.createAssetsFromUpload(ctx, campaign.id, { mediaId: m.id, channels: ['instagram', 'tiktok', 'whatsapp_status'], title: 'Launch video', description: 'Shows the auto-crop' });
    assert.equal(r.created.length, 3);
    assert.equal(r.format, 'reel');
    const a = ctx.db.byId('creative_assets', r.created[0]);
    assert.equal(a.content.uploaded, true);
    assert.match(a.utm_url, /utm_content=reel-/);
    // package regeneration must not overwrite uploaded drafts
    await core.generatePackage(ctx, campaign.id, { channels: ['instagram'], formats: ['reel'] });
    assert.equal(ctx.db.byId('creative_assets', a.id).content.uploaded, true);
    // regenerate rewrites the caption only
    const rg = await core.regenerateAsset(ctx, a.id);
    assert.equal(rg.asset.content.uploaded, true);
    assert.equal(rg.asset.content.mediaId, m.id);
  });
});

describe('soundtrack for uploaded / AI videos', () => {
  test('mixed WAV is muxed onto the clip without re-encoding the picture; original kept', async () => {
    try {
      execFileSyncTop('ffmpeg', ['-version'], { stdio: 'ignore' });
    } catch {
      return;
    }
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lls-'));
    const mp4 = path.join(dir, 'clip.mp4');
    const wav = path.join(dir, 'mix.wav');
    execFileSyncTop('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=24:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
    execFileSyncTop('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-ac', '2', '-ar', '48000', wav]);
    const { addFinalVideo, addMuxedVideo } = await import('../src/services/library.js');
    const { ctx, workspace, campaign } = await setup();
    const orig = await addFinalVideo(ctx.db, workspace, { tmpPath: mp4, mime: 'video/mp4', name: 'clip.mp4', label: 'AI · test', dataDir: dir });
    const { created } = await core.createAssetsFromUpload(ctx, campaign.id, { mediaId: orig.id, channels: ['instagram'], title: 'Clip', aiCaptions: false });
    const m = await addMuxedVideo(ctx.db, workspace, { videoMediaId: orig.id, audioPath: wav, label: 'Clip + music', dataDir: dir });
    const row = ctx.db.get(null, 'SELECT * FROM media WHERE id = ?', m.id);
    const probe = execFileSyncTop('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', row.path]).toString();
    assert.match(probe, /h264/);
    assert.match(probe, /aac/);
    const a = core.editAsset(ctx, created[0], { content: { mediaId: m.id, originalMediaId: orig.id, soundtrack: { music: 'upbeat' } } });
    assert.equal(a.content.mediaId, m.id);
    assert.equal(a.content.originalMediaId, orig.id);
    assert.equal(a.content.uploaded, true);
  });
});

describe('accounts: sign-up, sign-in, Google', () => {
  let srv;
  let base;
  before(async () => {
    srv = await start({ port: 0, dbFile: ':memory:', worker: false, appApiToken: 'secret-token-123' });
    base = `http://localhost:${srv.port}`;
  });
  after(() => srv.server.close());
  const post = (url, body, cookie) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const sid = (r) => (r.headers.getSetCookie().find((c) => c.startsWith('ll_sid=')) || '').split(';')[0];

  test('sign-up needs the access code; the account then signs in and reaches the API', async () => {
    assert.equal((await fetch(`${base}/api/workspaces`)).status, 401);
    assert.equal((await post('/api/auth/signup', { name: 'Ama', email: 'ama@example.com', password: 'launch2026!' })).status, 403);
    assert.equal((await post('/api/auth/signup', { name: 'Ama', email: 'ama@example.com', password: 'launch2026!', accessCode: 'nope' })).status, 403);
    assert.equal((await post('/api/auth/signup', { name: 'Ama', email: 'ama@example.com', password: 'short', accessCode: 'secret-token-123' })).status, 400);
    const r = await post('/api/auth/signup', { name: 'Ama', email: 'Ama@Example.com', password: 'launch2026!', accessCode: 'secret-token-123' });
    assert.equal(r.status, 200);
    const u = (await r.json()).user;
    assert.equal(u.email, 'ama@example.com');
    assert.equal(u.role, 'owner');
    const setc = r.headers.getSetCookie().join('\n');
    assert.match(setc, /HttpOnly/);
    assert.match(setc, /Max-Age=31536000/);
    const c = sid(r);
    assert.equal((await fetch(`${base}/api/workspaces`, { headers: { cookie: c } })).status, 200);
    const s = await (await fetch(`${base}/api/session`, { headers: { cookie: c } })).json();
    assert.equal(s.user.name, 'Ama');
    assert.equal((await post('/api/auth/signup', { name: 'X', email: 'ama@example.com', password: 'launch2026!', accessCode: 'secret-token-123' })).status, 409);

    assert.equal((await post('/api/auth/signin', { email: 'ama@example.com', password: 'wrong-pass1' })).status, 401);
    const r2 = await post('/api/auth/signin', { email: 'ama@example.com', password: 'launch2026!' });
    assert.equal(r2.status, 200);
    const c2 = sid(r2);
    assert.equal((await post('/api/auth/signout', {}, c2)).status, 200);
    assert.equal((await fetch(`${base}/api/workspaces`, { headers: { cookie: c2 } })).status, 401, 'signed-out session no longer works');
    assert.equal((await fetch(`${base}/api/workspaces`, { headers: { cookie: c } })).status, 200, 'other sessions stay signed in');
    assert.equal((await fetch(`${base}/api/workspaces`, { headers: { authorization: 'Bearer secret-token-123' } })).status, 200, 'scripts can still use the token');
    assert.equal((await fetch(`${base}/api/workspaces`, { headers: { cookie: 'll_session=secret-token-123' } })).status, 401, 'old token cookie no longer signs in');
  });

  test('password reset with the access code signs out other sessions', async () => {
    const r = await post('/api/auth/signup', { name: 'Kofi', email: 'kofi@example.com', password: 'first-pass1', accessCode: 'secret-token-123' });
    const old = sid(r);
    assert.equal((await post('/api/auth/reset-with-code', { email: 'kofi@example.com', accessCode: 'bad', password: 'second-pass2' })).status, 403);
    const r2 = await post('/api/auth/reset-with-code', { email: 'kofi@example.com', accessCode: 'secret-token-123', password: 'second-pass2' });
    assert.equal(r2.status, 200);
    assert.equal((await fetch(`${base}/api/workspaces`, { headers: { cookie: old } })).status, 401);
    assert.equal((await post('/api/auth/signin', { email: 'kofi@example.com', password: 'second-pass2' })).status, 200);
  });

  test('sign-in pages are served and www redirects to the main address', async () => {
    for (const pth of ['/signin', '/signup', '/forgot-password', '/reset-password']) assert.match(await (await fetch(`${base}${pth}`)).text(), /auth\.js/);
    const cfg = await (await fetch(`${base}/api/auth/config`)).json();
    assert.equal(cfg.signupNeedsCode, true);
    assert.equal((await fetch(`${base}/api/auth/google/start?mode=signin`, { redirect: 'manual' })).headers.get('location'), '/signin?error=google_not_configured');
    const http = await import('node:http');
    const r = await new Promise((ok, no) => http.get({ port: srv.port, path: '/studio', headers: { host: 'www.applaunchloop.com' } }, ok).on('error', no));
    r.resume();
    assert.equal(r.statusCode, 301);
    assert.equal(r.headers.location, 'https://applaunchloop.com/studio');
  });

  test('Google sign-in: new user needs the access code, then signs in; claims are checked', async () => {
    const { Auth } = await import('../src/services/auth.js');
    const db = openDb(':memory:');
    let claims;
    const auth = new Auth({
      db,
      config: { appApiToken: 'tok', env: { GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'sec' } },
      fetchImpl: async (url, o) => {
        assert.equal(url, 'https://oauth2.googleapis.com/token');
        assert.match(String(o.body), /client_secret=sec/);
        return new Response(JSON.stringify({ id_token: `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s` }));
      },
    });
    const fakeRes = () => {
      const h = {};
      return { h, getHeader: (k) => h[k], setHeader: (k, v) => (h[k] = v) };
    };
    const reqWith = (cookies) => ({ headers: { host: 'applaunchloop.com', 'x-forwarded-proto': 'https', cookie: cookies }, socket: {} });
    const cookiesOf = (res) => [].concat(res.h['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    const flow = async (pre = '') => {
      const res1 = fakeRes();
      const url = new URL(auth.googleStartUrl(reqWith(pre), res1, { next: '/#/studio', mode: 'signup' }));
      assert.equal(url.searchParams.get('redirect_uri'), 'https://applaunchloop.com/api/auth/google/callback');
      claims = { iss: 'https://accounts.google.com', aud: 'cid.apps.googleusercontent.com', exp: Date.now() / 1000 + 600, nonce: url.searchParams.get('nonce'), sub: 'g-1', email: 'Esi@Gmail.com', email_verified: true, name: 'Esi M', picture: 'https://x/p.jpg' };
      const res2 = fakeRes();
      const out = await auth.googleCallback(reqWith(cookiesOf(res1)), res2, { code: 'c', state: url.searchParams.get('state') });
      return { out, res2 };
    };
    let { out } = await flow();
    assert.match(out.redirect, /^\/signup\?error=needs_code&email=esi%40gmail.com/);
    const prep = fakeRes();
    auth.googlePrepare(reqWith(''), prep, { accessCode: 'tok' });
    ({ out } = await flow(cookiesOf(prep)));
    assert.equal(out.redirect, '/#/studio');
    const u = db.get(null, 'SELECT * FROM users WHERE email = ?', 'esi@gmail.com');
    assert.equal(u.google_sub, 'g-1');
    assert.equal(u.role, 'owner');
    ({ out } = await flow()); // returning user: no code needed
    assert.equal(out.redirect, '/#/studio');
    // a tampered state is rejected
    const res1 = fakeRes();
    auth.googleStartUrl(reqWith(''), res1, { next: '/' });
    assert.match((await auth.googleCallback(reqWith(cookiesOf(res1)), fakeRes(), { code: 'c', state: 'forged' })).redirect, /google_expired/);
    assert.throws(() => auth.googlePrepare(reqWith(''), fakeRes(), { accessCode: 'wrong' }), /not right/);
  });
});
