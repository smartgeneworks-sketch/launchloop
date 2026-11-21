/**
 * Scheduler worker. Runs in-process on an interval for the MVP; the same
 * `tick()` can be driven by a cron/queue (e.g. a Vercel Cron hitting
 * POST /api/worker/tick, or BullMQ) in production.
 *
 * Guarantees:
 *  - Only assets in state SCHEDULED are ever published (re-checked at run time).
 *  - Jobs are claimed atomically (pending/retry → running) so two workers can't double-post.
 *  - Auto-publish requires: asset.auto_publish AND channel in API mode AND channel auto_publish on.
 *    Otherwise the job becomes `manual_required` and a Share Kit task is created.
 *  - Failures retry with exponential backoff (3 attempts) before the asset becomes FAILED.
 */
import { CHANNELS } from './lib/channels.js';
import { addDays, id, isoDate, nowIso } from './lib/util.js';
import { afterPublish, connectionFor } from './services/core.js';
import { ManualRequired, finalCaption } from './services/publisher.js';
import { transition } from './services/stateMachine.js';

const MAX_ATTEMPTS = 3;
const BACKOFF_S = [30, 120, 600];

export function createWorker({ db, publisher, config, notifier = null }) {
  let timer = null;
  let running = false;
  const state = { lastTick: null, processed: 0 };

  const log = (job, level, msg) => {
    const entry = { at: nowIso(), level, msg };
    db.update('schedule_jobs', job.id, { log: [...(db.byId('schedule_jobs', job.id).log || []), entry] });
  };

  async function runJob(job) {
    const claimed = db.run(`UPDATE schedule_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('pending','retry')`, nowIso(), job.id);
    if (Number(claimed.changes) !== 1) return;
    job = db.byId('schedule_jobs', job.id);
    const asset = db.byId('creative_assets', job.asset_id);
    if (!asset || asset.state !== 'SCHEDULED') {
      db.update('schedule_jobs', job.id, { status: 'cancelled' });
      log(job, 'warn', `Skipped: asset is ${asset?.state || 'missing'}, not SCHEDULED`);
      return;
    }
    const campaign = db.byId('campaigns', asset.campaign_id);
    const conn = connectionFor(db, campaign.workspace_id, asset.channel);
    const label = CHANNELS[asset.channel]?.label || asset.channel;
    try {
      if (!asset.auto_publish) throw new ManualRequired('Auto-publish is off for this item');
      if (conn?.mode === 'api' && !conn.auto_publish) throw new ManualRequired(`Auto-publish rule is off for ${label}`);
      log(job, 'info', `Publishing to ${label} (attempt ${job.attempts}, ${publisher.mode} mode)`);
      const res = await publisher.publish({ asset: { ...asset, caption: asset.caption }, connection: conn, caption: finalCaption(asset) });
      db.tx(() => {
        const updated = transition(db, asset, 'PUBLISHED', { actor: 'worker', note: res.simulated ? 'Published (simulated)' : 'Published via API', patch: { published_at: nowIso(), external_url: res.url || null, error: null } });
        db.update('schedule_jobs', job.id, { status: 'done', last_error: null });
        afterPublish(db, updated);
      });
      log(job, 'success', `Published to ${label}${res.url ? ` → ${res.url}` : ''}`);
      if (res.simulated && config.simulateMetrics) seedSimulatedMetrics(db, asset, 1);
    } catch (e) {
      if (e.manual) {
        db.tx(() => {
          db.update('schedule_jobs', job.id, { status: 'manual_required', last_error: e.message });
          const exists = db.get(null, `SELECT id FROM campaign_tasks WHERE asset_id = ? AND category = 'Publishing' AND done = 0`, asset.id);
          if (!exists)
            db.insert('campaign_tasks', {
              id: id('tsk'),
              campaign_id: campaign.id,
              title: `Publish via Share Kit: ${asset.title}`,
              description: `${e.message}. Open the Share Kit, post it, then mark it as published.`,
              category: 'Publishing',
              role: 'Marketer',
              due_date: isoDate(new Date()),
              source: 'scheduler',
              asset_id: asset.id,
              sort: 0,
            });
        });
        log(job, 'info', `Manual publishing required — ${e.message}. Share Kit task created.`);
        notifier?.postDue(asset).catch((err) => console.warn('[notify]', err.message));
        return;
      }
      const attempts = job.attempts;
      if (attempts < MAX_ATTEMPTS) {
        const next = new Date(Date.now() + BACKOFF_S[attempts - 1] * 1000).toISOString();
        db.update('schedule_jobs', job.id, { status: 'retry', run_at: next, last_error: e.message });
        log(job, 'warn', `Attempt ${attempts} failed: ${e.message}. Retrying at ${next}`);
      } else {
        db.tx(() => {
          db.update('schedule_jobs', job.id, { status: 'failed', last_error: e.message });
          transition(db, asset, 'FAILED', { actor: 'worker', note: e.message, patch: { error: e.message } });
          db.insert('campaign_tasks', {
            id: id('tsk'),
            campaign_id: campaign.id,
            title: `Fix failed post: ${asset.title}`,
            description: e.message,
            category: 'Publishing',
            role: 'Marketer',
            due_date: isoDate(new Date()),
            source: 'scheduler',
            asset_id: asset.id,
            sort: 0,
          });
        });
        log(job, 'error', `Failed after ${attempts} attempts: ${e.message}. Asset marked FAILED.`);
        notifier?.publishFailed(asset, e.message).catch((err) => console.warn('[notify]', err.message));
      }
    }
  }

  async function tick() {
    if (running) return { skipped: true };
    running = true;
    try {
      const due = db.all('schedule_jobs', `SELECT * FROM schedule_jobs WHERE status IN ('pending','retry') AND run_at <= ? ORDER BY run_at LIMIT 25`, nowIso());
      for (const job of due) {
        await runJob(job);
        state.processed++;
      }
      if (publisher.mode === 'mock' && config.simulateMetrics) growSimulatedMetrics(db);
      if (notifier) await notifier.digestTick().catch((err) => console.warn('[notify] digest', err.message));
      state.lastTick = nowIso();
      return { processed: due.length };
    } finally {
      running = false;
    }
  }

  return {
    tick,
    state,
    start() {
      if (timer) return;
      timer = setInterval(() => tick().catch((e) => console.error('[worker]', e)), config.workerIntervalMs);
      timer.unref?.();
      setTimeout(() => tick().catch((e) => console.error('[worker]', e)), 1000).unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

/** Clearly-labelled simulated engagement so the analytics loop is demoable offline. */
export function seedSimulatedMetrics(db, asset, days = 1, startDate = new Date()) {
  const quality = (asset.score?.overall || 60) / 100;
  for (let d = 0; d < days; d++) {
    const impressions = Math.round((300 + Math.random() * 900) * (0.5 + quality) * (d === 0 ? 1.6 : 1 / (1 + d * 0.4)));
    const clicks = Math.round(impressions * (0.012 + Math.random() * 0.03) * (0.6 + quality));
    db.insert('campaign_metrics', {
      id: id('met'),
      campaign_id: asset.campaign_id,
      asset_id: asset.id,
      channel: asset.channel,
      date: isoDate(addDays(startDate, d)),
      impressions,
      clicks,
      shares: Math.round(impressions * (0.002 + Math.random() * 0.008)),
      signups: Math.round(clicks * (0.05 + Math.random() * 0.1)),
      source: 'simulated',
      created_at: nowIso(),
    });
  }
}

function growSimulatedMetrics(db) {
  const recent = db.all('creative_assets', `SELECT * FROM creative_assets WHERE state = 'PUBLISHED' AND published_at >= ?`, addDays(new Date(), -7).toISOString());
  for (const a of recent) {
    if (Math.random() > 0.5) continue;
    const imp = Math.round(10 + Math.random() * 60);
    const clicks = Math.round(imp * (0.01 + Math.random() * 0.04));
    const row = db.get(null, `SELECT id FROM campaign_metrics WHERE asset_id = ? AND date = ? AND source = 'simulated'`, a.id, isoDate(new Date()));
    if (row) db.run(`UPDATE campaign_metrics SET impressions = impressions + ?, clicks = clicks + ?, shares = shares + ?, signups = signups + ? WHERE id = ?`, imp, clicks, Math.random() < 0.3 ? 1 : 0, Math.random() < 0.15 ? 1 : 0, row.id);
    else seedSimulatedMetrics(db, a, 1);
  }
}
