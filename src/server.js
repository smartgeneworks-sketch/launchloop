/**
 * LaunchLoop HTTP server — zero dependencies (Node ≥ 22.5: node:http + node:sqlite).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { CHANNELS, FORMATS, TASK_CATEGORIES } from './lib/channels.js';
import { loadEnv } from './lib/env.js';
import { HttpError, timingSafeEqualStr } from './lib/util.js';
import { AIService } from './services/ai.js';
import * as core from './services/core.js';
import { buildRenderJob, renderAssetSvg } from './services/media.js';
import { Publisher } from './services/publisher.js';
import { scoreAsset } from './services/scorer.js';
import { TTSService, assetVoiceover } from './services/tts.js';
import { FontService } from './services/fonts.js';
import { addFinalVideo, addMedia, addVideo, deleteMedia, getMedia, listMedia, mediaDataUrl, resolveSceneMedia } from './services/library.js';
import { VideoGen, scenePrompt } from './services/videogen.js';
import { FONTS, PAIRINGS } from './lib/fonts.js';
import { Notifier } from './services/notify.js';
import { SUGGESTED_TIMES, WEEKDAY_ONLY, applySchedule, bulkTransition, planSchedule } from './services/scheduling.js';
import { STATES, allowedNext } from './services/stateMachine.js';
import { buildUtmUrl } from './services/utm.js';
import { createWorker } from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const MAX_BODY = 6 * 1024 * 1024;

export function createApp({ db, ai, config, publisher, worker, tts = new TTSService(config.env, { dataDir: config.dataDir }), fonts = new FontService({ dataDir: config.dataDir }), notifier = new Notifier({ db, config }), videogen = new VideoGen({ db, config }) }) {
  const ctx = { db, ai, config };
  const routes = [];
  const on = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, handler, ...opts });
  };
  const must = (row, what) => {
    if (!row) throw new HttpError(404, `${what} not found`);
    return row;
  };
  const withAllowed = (a) => a && { ...a, allowed_next: allowedNext(a.state) };

  // ---------------------------------------------------------------- meta
  on('GET', '/api/health', () => ({ ok: true, ai: ai.info(), publishMode: publisher.mode, worker: { intervalMs: config.workerIntervalMs, ...worker?.state }, authRequired: !!config.appApiToken, tts: { available: tts.info().available, model: tts.info().model, lastError: tts.lastError } }), { public: true });
  on('GET', '/api/config', () => ({ channels: CHANNELS, formats: FORMATS, states: STATES, taskCategories: TASK_CATEGORIES, publicBaseUrl: config.publicBaseUrl, fonts: FONTS, pairings: PAIRINGS }));
  on('POST', '/api/worker/tick', async () => worker.tick());

  // ---------------------------------------------------------------- workspaces
  on('GET', '/api/workspaces', () => db.all('workspaces', 'SELECT id, name, website_url, tagline, created_at FROM workspaces ORDER BY created_at'));
  on('POST', '/api/workspaces', ({ body }) => core.createWorkspace(ctx, body));
  on('GET', '/api/workspaces/:id', ({ p }) => must(db.byId('workspaces', p.id), 'Workspace'));
  on('PATCH', '/api/workspaces/:id', ({ p, body }) => core.updateWorkspace(ctx, p.id, body));
  on('POST', '/api/workspaces/:id/ingest', ({ p, body }) => core.ingestWorkspace(ctx, p.id, body));
  on('POST', '/api/workspaces/:id/rotate-secret', ({ p }) => db.update('workspaces', must(db.byId('workspaces', p.id), 'Workspace').id, { webhook_secret: `whsec_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}` }));
  on('GET', '/api/workspaces/:id/channels', ({ p }) => db.all('channel_connections', 'SELECT * FROM channel_connections WHERE workspace_id = ? ORDER BY channel', p.id));
  on('PATCH', '/api/channels/:id', ({ p, body }) => core.updateChannel(ctx, p.id, body));
  on('GET', '/api/workspaces/:id/campaigns', ({ p }) => db.all('campaigns', 'SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC', p.id));
  on('POST', '/api/workspaces/:id/campaigns', ({ p, body }) => core.createCampaign(ctx, p.id, body));
  on('GET', '/api/workspaces/:id/logo', ({ p, res }) => {
    const ws = must(db.byId('workspaces', p.id), 'Workspace');
    const m = String(ws.brand?.logo || '').match(/^data:([^;]+);base64,(.*)$/);
    if (!m) throw new HttpError(404, 'No logo');
    res.writeHead(200, { 'content-type': m[1], 'cache-control': 'no-cache' });
    res.end(Buffer.from(m[2], 'base64'));
  }, { raw: true });

  // ---------------------------------------------------------------- campaigns
  on('GET', '/api/campaigns/:id', ({ p }) => must(db.byId('campaigns', p.id), 'Campaign'));
  on('PATCH', '/api/campaigns/:id', ({ p, body }) => {
    must(db.byId('campaigns', p.id), 'Campaign');
    const out = {};
    for (const k of ['name', 'goal', 'base_url', 'launch_date', 'status', 'channels']) if (k in body) out[k] = body[k];
    return db.update('campaigns', p.id, out);
  });
  on('GET', '/api/campaigns/:id/progress', ({ p }) => core.progress(ctx, p.id));
  on('POST', '/api/campaigns/:id/generate', ({ p, body }) => core.generatePackage(ctx, p.id, body));
  on('POST', '/api/campaigns/:id/submit-drafts', ({ p }) => core.submitDrafts(ctx, p.id));
  on('POST', '/api/campaigns/:id/iterate', ({ p, body }) => core.iterateOnTopPerformer(ctx, p.id, body).then(withAllowed));
  on('GET', '/api/campaigns/:id/assets', ({ p, q }) => {
    const rows = q.state
      ? db.all('creative_assets', 'SELECT * FROM creative_assets WHERE campaign_id = ? AND state = ? ORDER BY created_at', p.id, q.state)
      : db.all('creative_assets', 'SELECT * FROM creative_assets WHERE campaign_id = ? ORDER BY created_at', p.id);
    return rows.map(withAllowed);
  });
  on('GET', '/api/campaigns/:id/tasks', ({ p }) => db.all('campaign_tasks', 'SELECT * FROM campaign_tasks WHERE campaign_id = ? ORDER BY due_date, sort', p.id));
  on('POST', '/api/campaigns/:id/tasks', ({ p, body }) => core.addTask(ctx, p.id, body));
  on('GET', '/api/campaigns/:id/metrics', ({ p }) => core.assetMetrics(db, p.id));
  on('GET', '/api/campaigns/:id/jobs', ({ p }) => db.all('schedule_jobs', 'SELECT j.* FROM schedule_jobs j JOIN creative_assets a ON a.id = j.asset_id WHERE a.campaign_id = ? ORDER BY j.run_at DESC', p.id));
  on('PATCH', '/api/tasks/:id', ({ p, body }) => core.updateTask(ctx, p.id, body));
  on('DELETE', '/api/tasks/:id', ({ p }) => (db.run('DELETE FROM campaign_tasks WHERE id = ?', p.id), { deleted: true }));

  // ---------------------------------------------------------------- assets
  on('GET', '/api/assets/:id', ({ p }) => {
    const a = must(db.byId('creative_assets', p.id), 'Asset');
    return { ...withAllowed(a), events: db.all('asset_events', 'SELECT * FROM asset_events WHERE asset_id = ? ORDER BY at', a.id), jobs: db.all('schedule_jobs', 'SELECT * FROM schedule_jobs WHERE asset_id = ? ORDER BY created_at', a.id) };
  });
  on('PATCH', '/api/assets/:id', ({ p, body }) => withAllowed(core.editAsset(ctx, p.id, body)));
  on('POST', '/api/assets/:id/regenerate', async ({ p, body }) => {
    const r = await core.regenerateAsset(ctx, p.id, body);
    return { ...r, asset: withAllowed(r.asset) };
  });
  on('POST', '/api/assets/:id/transition', ({ p, body }) => withAllowed(core.transitionAsset(ctx, p.id, body.to, body)));
  on('POST', '/api/assets/:id/schedule', ({ p, body }) => withAllowed(core.scheduleAsset(ctx, p.id, body)));
  on('POST', '/api/assets/:id/unschedule', ({ p }) => withAllowed(core.unscheduleAsset(ctx, p.id)));
  on('POST', '/api/assets/:id/retry', ({ p, body }) => withAllowed(core.scheduleAsset(ctx, p.id, { runAt: body.runAt || new Date().toISOString() })));
  on('POST', '/api/assets/:id/mark-published', ({ p, body }) => withAllowed(core.markPublished(ctx, p.id, body)));
  on('POST', '/api/assets/:id/metrics', ({ p, body }) => core.addMetrics(ctx, p.id, body, 'manual'));
  on('POST', '/api/assets/:id/score', ({ p }) => {
    const a = must(db.byId('creative_assets', p.id), 'Asset');
    const ws = db.get('workspaces', 'SELECT w.* FROM workspaces w JOIN campaigns c ON c.workspace_id = w.id WHERE c.id = ?', a.campaign_id);
    return db.update('creative_assets', a.id, { score: scoreAsset(a, ws) }).score;
  });
  on('GET', '/api/tts', () => tts.info());
  on('POST', '/api/assets/:id/voiceover', async ({ p, body }) => {
    const a = must(db.byId('creative_assets', p.id), 'Asset');
    if (!['reel', 'video'].includes(a.format)) throw new HttpError(400, 'Voiceover is only for reels and short videos');
    return assetVoiceover(tts, a, { voice: body.voice || 'Puck', style: String(body.style || '').slice(0, 80) });
  });
  // Convert a browser recording (WebM / VP9 / Opus) to a universally accepted H.264 + AAC MP4.
  on('POST', '/api/transcode', async ({ rawBody, res }) => {
    if (!rawBody?.length) throw new HttpError(400, 'Send the video file as the request body');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'll-'));
    const input = path.join(dir, 'in');
    const output = path.join(dir, 'out.mp4');
    fs.writeFileSync(input, rawBody);
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-i', input, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', output]);
        let err = '';
        ff.stderr.on('data', (d) => (err += d));
        ff.on('error', () => reject(new HttpError(501, 'ffmpeg is not installed on the server')));
        ff.on('close', (code) => (code === 0 ? resolve() : reject(new HttpError(500, `Conversion failed: ${err.slice(-300)}`))));
      });
      const out = fs.readFileSync(output);
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': out.length });
      res.end(out);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, { raw: true, binary: true, maxBody: 150 * 1024 * 1024 });
  on('GET', '/api/assets/:id/share-kit', ({ p }) => core.shareKit(ctx, p.id));
  on('GET', '/api/assets/:id/render-job', ({ p }) => {
    const a = must(db.byId('creative_assets', p.id), 'Asset');
    const ws = db.get('workspaces', 'SELECT w.* FROM workspaces w JOIN campaigns c ON c.workspace_id = w.id WHERE c.id = ?', a.campaign_id);
    return buildRenderJob(a, ws, { publicBaseUrl: config.publicBaseUrl });
  });
  on('GET', '/api/assets/:id/media.svg', async ({ p, q, res }) => {
    const a = must(db.byId('creative_assets', p.id), 'Asset');
    const ws = db.get('workspaces', 'SELECT w.* FROM workspaces w JOIN campaigns c ON c.workspace_id = w.id WHERE c.id = ?', a.campaign_id);
    const svg = renderAssetSvg(a, ws, { slide: Number(q.slide || 0), ...(await prepareRender(a, ws)) });
    res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-cache', 'content-disposition': `inline; filename="${a.channel}-${a.format}-${a.id}.svg"` });
    res.end(svg);
  }, { raw: true, public: true });

  /** Fonts + the images this asset actually uses, embedded as data URLs (SVG-as-image can't fetch). */
  async function prepareRender(a, ws) {
    const library = listMedia(db, ws);
    const ids = new Set();
    if (a.content?.uploaded) ids.add(a.content.mediaId);
    else if (a.format === 'reel' || a.format === 'video') (a.content?.storyboard || []).forEach((s, i) => { const r = resolveSceneMedia(s, i, library); if (r) ids.add(r.item.id); });
    else if (a.content?.media?.id && a.content.media.id !== 'none') ids.add(a.content.media.id);
    const images = {};
    for (const mid of ids) images[mid] = mediaDataUrl(db, mid);
    if (!['reel', 'video', 'carousel'].includes(a.format) && !a.content?.media?.id && !ws.screenshots?.length && library[0]) images.__default = mediaDataUrl(db, library[0].id);
    return { library, images, fontCss: await fonts.forWorkspace(ws) };
  }

  // ---------------------------------------------------------------- media library & fonts
  on('GET', '/api/workspaces/:id/media', ({ p }) => listMedia(db, must(db.byId('workspaces', p.id), 'Workspace')));
  on('POST', '/api/workspaces/:id/media', ({ p, body }) => addMedia(db, must(db.byId('workspaces', p.id), 'Workspace'), body), { maxBody: 10 * 1024 * 1024 });
  on('PATCH', '/api/media/:id', ({ p, body }) => {
    const m = p.id.match(/^wsshot_(ws_[a-f0-9]+)_(\d+)$/);
    if (m) {
      const w = must(db.byId('workspaces', m[1]), 'Workspace');
      const shots = [...w.screenshots];
      if (!shots[Number(m[2])]) throw new HttpError(404, 'Image not found');
      shots[Number(m[2])] = { ...shots[Number(m[2])], label: String(body.label || '').slice(0, 160) };
      db.update('workspaces', w.id, { screenshots: shots });
      return { id: p.id, label: body.label };
    }
    must(db.get(null, 'SELECT id FROM media WHERE id = ?', p.id), 'Image');
    db.run('UPDATE media SET label = ? WHERE id = ?', String(body.label || '').slice(0, 160), p.id);
    return { id: p.id, label: body.label };
  });
  on('POST', '/api/workspaces/:id/media/video', ({ p, q, headers, rawBody }) => addVideo(db, must(db.byId('workspaces', p.id), 'Workspace'), { buffer: rawBody, mime: headers['content-type'], name: q.name, label: q.label, dataDir: config.dataDir }), { binary: true, maxBody: 85 * 1024 * 1024 });
  on('DELETE', '/api/media/:id', ({ p }) => (deleteMedia(db, p.id), { deleted: true }));
  on('GET', '/api/media/:id/poster', ({ p, res }) => {
    const m = getMedia(db, p.id);
    if (!m?.poster || !fs.existsSync(m.poster)) throw new HttpError(404, 'No poster');
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
    fs.createReadStream(m.poster).pipe(res);
  }, { raw: true, public: true });
  on('GET', '/api/media/:id', ({ p, q, req, res }) => {
    const m = getMedia(db, p.id);
    if (q.download && m?.path) res.setHeader('content-disposition', `attachment; filename="${p.id}.mp4"`);
    if (!m) throw new HttpError(404, 'Media not found');
    if (!m.path) {
      res.writeHead(200, { 'content-type': m.mime, 'cache-control': 'public, max-age=86400' });
      return res.end(m.data);
    }
    if (!fs.existsSync(m.path)) throw new HttpError(404, 'File missing');
    // Range support so videos can seek.
    const size = fs.statSync(m.path).size;
    const range = String(req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { 'content-type': m.mime, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' });
      return fs.createReadStream(m.path, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': m.mime, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400' });
    fs.createReadStream(m.path).pipe(res);
  }, { raw: true, public: true });
  on('GET', '/api/workspaces/:id/fonts.css', async ({ p, res }) => {
    const css = await fonts.forWorkspace(must(db.byId('workspaces', p.id), 'Workspace'));
    res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(css);
  }, { raw: true, public: true });

  // ---------------------------------------------------------------- AI motion clips
  on('GET', '/api/videogen', () => videogen.info());
  on('GET', '/api/workspaces/:id/videogen/jobs', ({ p }) => videogen.jobs(must(db.byId('workspaces', p.id), 'Workspace')));
  on('POST', '/api/workspaces/:id/videogen', ({ p, body }) => videogen.create(must(db.byId('workspaces', p.id), 'Workspace'), body));
  on('GET', '/api/assets/:id/scene-prompts', ({ p }) => {
    const a = must(db.byId('creative_assets', p.id), 'Asset');
    const ws = db.get('workspaces', 'SELECT w.* FROM workspaces w JOIN campaigns c ON c.workspace_id = w.id WHERE c.id = ?', a.campaign_id);
    const aspect = a.aspect_ratio === '9:16' ? '9:16' : '16:9';
    return (a.content?.storyboard || []).map((s, i) => ({ index: i, type: s.type, start: s.start, end: s.end, onScreenText: s.onScreenText, prompt: scenePrompt(s, ws, aspect), suggested: ['hook', 'problem', 'cta'].includes(s.type) }));
  });
  on('POST', '/api/assets/:id/videogen-scenes', ({ p, body }) => {
    const a = must(db.byId('creative_assets', p.id), 'Asset');
    if (!['DRAFT', 'NEEDS_REVISION', 'NEEDS_REVIEW'].includes(a.state)) throw new HttpError(409, 'Send this creative back to draft or review before adding AI clips');
    const ws = db.get('workspaces', 'SELECT w.* FROM workspaces w JOIN campaigns c ON c.workspace_id = w.id WHERE c.id = ?', a.campaign_id);
    return videogen.forScenes(a, ws, body);
  });

  // ---------------------------------------------------------------- uploaded finished videos
  on('POST', '/api/workspaces/:id/media/final', async ({ p, q, req, headers }) => {
    const ws = must(db.byId('workspaces', p.id), 'Workspace');
    const max = 300 * 1024 * 1024;
    if (Number(headers['content-length'] || 0) > max) throw new HttpError(413, 'Videos must be under 300 MB');
    const tmp = path.join(os.tmpdir(), `ll-up-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await new Promise((resolve, reject) => {
      let size = 0;
      const out = fs.createWriteStream(tmp);
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          req.destroy();
          out.destroy();
          fs.rmSync(tmp, { force: true });
          reject(new HttpError(413, 'Videos must be under 300 MB'));
        }
      });
      req.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
      req.on('error', reject);
    });
    return addFinalVideo(db, ws, { tmpPath: tmp, mime: headers['content-type'], name: q.name, label: q.label, dataDir: config.dataDir });
  }, { stream: true });
  on('POST', '/api/campaigns/:id/assets/from-upload', ({ p, body }) => core.createAssetsFromUpload(ctx, p.id, body));

  // ---------------------------------------------------------------- bulk scheduling
  on('GET', '/api/scheduling/defaults', () => ({ times: SUGGESTED_TIMES, weekdayOnly: WEEKDAY_ONLY }));
  on('POST', '/api/campaigns/:id/auto-schedule', ({ p, body }) => {
    must(db.byId('campaigns', p.id), 'Campaign');
    return body.dryRun ? planSchedule(db, p.id, body) : applySchedule(ctx, p.id, body);
  });
  on('POST', '/api/campaigns/:id/bulk-transition', ({ p, body }) => (must(db.byId('campaigns', p.id), 'Campaign'), bulkTransition(ctx, p.id, body)));

  // ---------------------------------------------------------------- reminders (email + WhatsApp)
  on('GET', '/api/workspaces/:id/notifications', ({ p }) => {
    const ws = must(db.byId('workspaces', p.id), 'Workspace');
    return { settings: notifier.settings(ws), providers: notifier.providers(), log: notifier.log(ws, 15) };
  });
  on('PUT', '/api/workspaces/:id/notifications', ({ p, body }) => notifier.saveSettings(must(db.byId('workspaces', p.id), 'Workspace'), body));
  on('POST', '/api/workspaces/:id/notifications/test', async ({ p, body }) => {
    const ws = must(db.byId('workspaces', p.id), 'Workspace');
    const s = notifier.settings(ws);
    const channel = body.channel === 'whatsapp' ? 'whatsapp' : 'email';
    if (!s[channel]) throw new HttpError(400, channel === 'email' ? 'Add an email address first' : 'Add a WhatsApp number first');
    if (!notifier.providers()[channel].configured) throw new HttpError(409, channel === 'email' ? 'Email sending is not set up on the server yet (RESEND_API_KEY and NOTIFY_EMAIL_FROM).' : 'WhatsApp sending is not set up on the server yet (WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID).');
    const [r] = await notifier.notify(ws, { kind: 'test', key: 'test', force: true, only: channel, subject: 'LaunchLoop test reminder', title: 'Reminders are working ✓', lines: [`This is a test ${channel === 'email' ? 'email' : 'WhatsApp message'} from LaunchLoop for ${ws.name}.`, 'You will get messages like this when a post is due, when a post fails, and in your daily digest.'], link: notifier.link('#/'), linkLabel: 'Open LaunchLoop' });
    if (!r || r.status !== 'sent') throw new HttpError(502, r?.error || 'Send failed');
    return { sent: true, channel };
  });
  on('POST', '/api/workspaces/:id/notifications/digest-now', async ({ p }) => {
    const ws = must(db.byId('workspaces', p.id), 'Workspace');
    const s = notifier.settings(ws);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: s.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const d = notifier.digestFor(ws, today, s.timezone);
    if (!d) return { sent: false, reason: 'Nothing scheduled or pending today' };
    const r = await notifier.notify(ws, { kind: 'digest', key: `digest-preview:${Date.now()}`, force: true, subject: 'LaunchLoop today (preview)', title: 'Your LaunchLoop plan for today', lines: d.lines, link: notifier.link('#/'), linkLabel: 'Open dashboard' });
    return { sent: r.some((x) => x.status === 'sent'), results: r.map(({ channel, status, error }) => ({ channel, status, error })), lines: d.lines };
  });

  // ---------------------------------------------------------------- tools
  on('POST', '/api/utm', ({ body }) => ({ url: buildUtmUrl(body.url, body) }));

  // ---------------------------------------------------------------- inbound webhooks (HMAC-authenticated)
  on('POST', '/api/webhooks/product-update', async ({ headers, rawBody, res }) => {
    const w = core.acceptWebhook(ctx, 'product-update', headers, rawBody);
    if (w.duplicate) return { duplicate: true, ...w.previous };
    const { campaign, job } = await core.handleProductUpdate(ctx, w.ws, w.payload);
    const result = { accepted: true, campaignId: campaign.id, status: 'generating', tasksCreated: db.scalar('SELECT COUNT(*) FROM campaign_tasks WHERE campaign_id = ?', campaign.id) };
    core.recordWebhook(ctx, w.ws, 'product-update', w.eventId, w.payload, result);
    job
      .then((r) => core.recordWebhook(ctx, w.ws, 'product-update', w.eventId, w.payload, { ...result, status: 'drafts_ready', assetsCreated: r.created.length }))
      .catch((e) => core.recordWebhook(ctx, w.ws, 'product-update', w.eventId, w.payload, { ...result, status: 'error', error: e.message }));
    res.statusCode = 202;
    return result;
  }, { public: true, rawBody: true });
  on('POST', '/api/webhooks/conversion', ({ headers, rawBody }) => {
    const w = core.acceptWebhook(ctx, 'conversion', headers, rawBody);
    if (w.duplicate) return { duplicate: true, ...w.previous };
    const result = core.handleConversion(ctx, w.ws, w.payload);
    core.recordWebhook(ctx, w.ws, 'conversion', w.eventId, w.payload, result);
    return result;
  }, { public: true, rawBody: true });
  on('GET', '/api/workspaces/:id/webhook-events', ({ p }) => db.all('webhook_events', 'SELECT * FROM webhook_events WHERE workspace_id = ? ORDER BY received_at DESC LIMIT 20', p.id));

  // ---------------------------------------------------------------- request handling
  async function readBody(req, max = MAX_BODY) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > max) throw new HttpError(413, 'Request body too large');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(target).pipe(res);
  }

  function send(res, status, data) {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
      const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!route) throw new HttpError(404, `No route for ${req.method} ${pathname}`);
      if (config.appApiToken && !route.public) {
        const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!timingSafeEqualStr(tok, config.appApiToken)) throw new HttpError(401, 'Missing or invalid API token');
      }
      const m = pathname.match(route.re);
      const p = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const rawBuf = ['POST', 'PATCH', 'PUT'].includes(req.method) && !route.stream ? await readBody(req, route.maxBody) : Buffer.alloc(0);
      const rawBody = route.binary ? rawBuf : rawBuf.toString('utf8');
      let body = {};
      if (rawBody && !route.rawBody && !route.binary) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          throw new HttpError(400, 'Body must be JSON');
        }
      }
      const out = await route.handler({ req, res, p, q: Object.fromEntries(url.searchParams), body, rawBody, headers: req.headers });
      if (!route.raw) send(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out ?? {});
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      send(res, status, { error: e.message, ...(e.details ? { details: e.details } : {}) });
    }
  };
}

export async function start(overrides = {}) {
  const config = { ...loadEnv(), ...overrides };
  const isProd = config.env.NODE_ENV === 'production';
  if (isProd && !config.appApiToken) {
    console.error('Refusing to start: NODE_ENV=production requires APP_API_TOKEN (otherwise your dashboard is public). Generate one with: openssl rand -hex 24');
    process.exit(1);
  }
  if (isProd && config.publicBaseUrl.includes('localhost')) console.warn('[warn] PUBLIC_BASE_URL still points at localhost — set it to your public https URL.');
  const db = openDb(overrides.dbFile || path.join(config.dataDir, 'launchloop.db'));
  const ai = new AIService(config.env);
  const publisher = new Publisher({ mode: config.publishMode, failureRate: config.mockFailureRate, env: config.env });
  const notifier = new Notifier({ db, config });
  const worker = createWorker({ db, publisher, config, notifier });
  core.syncChannelStatuses({ db, config });
  const seedDemo = config.env.SEED_DEMO ? config.env.SEED_DEMO === 'true' : !isProd;
  if (seedDemo && !db.scalar('SELECT COUNT(*) FROM workspaces')) {
    const { seed } = await import('./seed.js');
    await seed({ db, ai, config });
    console.log('[seed] Demo workspace "Relay" created');
  }
  const server = http.createServer(createApp({ db, ai, config, publisher, worker, notifier }));
  await new Promise((r) => server.listen(config.port, r));
  if (overrides.worker !== false) worker.start();
  const port = server.address().port;
  const shutdown = (sig) => {
    console.log(`${sig} received — shutting down`);
    worker.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  if (overrides.worker !== false) for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => shutdown(sig));
  console.log(`LaunchLoop running → http://localhost:${port}`);
  console.log(`  AI provider: ${ai.info().provider}${ai.info().model ? ` (${ai.info().model})` : ' (no key — deterministic mock generator)'}`);
  console.log(`  Publishing:  ${publisher.mode}${publisher.mode === 'mock' ? ' (simulated API adapters; Share Kit channels need manual posting)' : ''}`);
  return { server, db, worker, config, port };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) start();
