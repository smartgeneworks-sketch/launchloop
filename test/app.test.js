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
