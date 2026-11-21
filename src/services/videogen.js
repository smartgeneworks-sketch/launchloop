/**
 * AI motion clips with Gemini Omni Flash (Interactions API).
 * Jobs run in the background (generation can take minutes); results are converted
 * and stored in the media library via addVideo(), and optionally assigned to a scene.
 * Generated clips carry Google's SynthID watermark. Audio is dropped on import —
 * reels get LaunchLoop's voiceover and music instead.
 */
import { CHANNELS } from '../lib/channels.js';
import { HttpError, id, nowIso } from '../lib/util.js';
import { addVideo, getMedia } from './library.js';
import fs from 'node:fs';

const MAX_RUNNING = 2;

function regionName(code) {
  try {
    return (code && new Intl.DisplayNames(['en'], { type: 'region' }).of(code)) || '';
  } catch {
    return '';
  }
}

/** Prompt for one storyboard scene. Product UI is excluded on purpose — use real screen recordings for demos. */
export function scenePrompt(scene, ws, aspect) {
  const where = regionName(ws.locale?.region);
  const people = ws.audience ? `People: ${ws.audience}${where ? ` in ${where}` : ''}, natural and authentic, everyday clothing.` : '';
  return [
    `${scene.visual || scene.shot || scene.onScreenText}.`,
    scene.type === 'problem' ? 'Show the everyday frustration clearly, slightly muted colours.' : scene.type === 'hook' ? 'Arresting first second, dynamic camera move.' : scene.type === 'cta' ? 'Uplifting, satisfied mood, bright light.' : '',
    people,
    `Colour accents that echo ${ws.brand?.colors?.primary || ''} and ${ws.brand?.colors?.accent || ''}.`,
    `Single continuous shot, cinematic, natural lighting, ${aspect === '9:16' ? 'vertical framing' : 'widescreen framing'}.`,
    'No on-screen text, no captions, no logos, no phone or computer screens showing an app, no dialogue.',
  ]
    .filter(Boolean)
    .join(' ');
}

export class VideoGen {
  constructor({ db, config, fetchImpl = globalThis.fetch }) {
    this.db = db;
    this.config = config;
    this.env = config.env || {};
    this.fetch = fetchImpl;
    this.model = this.env.GEMINI_VIDEO_MODEL || 'gemini-omni-1.2-flash';
    this.running = 0;
    // Jobs interrupted by a restart can't resume — mark them failed.
    db.run(`UPDATE ai_video_jobs SET status = 'failed', error = 'Interrupted by a server restart — try again', updated_at = ? WHERE status IN ('queued','running')`, nowIso());
  }

  info() {
    return { available: !!this.env.GEMINI_API_KEY, provider: 'Gemini Omni Flash', model: this.model };
  }

  jobs(ws, limit = 20) {
    return this.db.all(null, 'SELECT * FROM ai_video_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?', ws.id, limit);
  }

  create(ws, { prompt, aspect = '9:16', duration = 6, referenceMediaId = null, assetId = null, sceneIndex = null, label = '' }) {
    if (!this.info().available) throw new HttpError(409, 'AI video needs GEMINI_API_KEY on the server');
    const text = String(prompt || '').trim();
    if (text.length < 8) throw new HttpError(400, 'Describe the clip in a sentence or two');
    if (!['9:16', '16:9'].includes(aspect)) throw new HttpError(400, 'Aspect must be 9:16 or 16:9');
    const secs = Math.max(3, Math.min(15, Math.round(Number(duration) || 6)));
    const job = this.db.insert('ai_video_jobs', { id: id('vjob'), workspace_id: ws.id, asset_id: assetId, scene_index: sceneIndex, prompt: text.slice(0, 2000), aspect, duration: secs, reference_media_id: referenceMediaId, label: String(label || text).slice(0, 120), status: 'queued', created_at: nowIso(), updated_at: nowIso() });
    this.pump();
    return job;
  }

  pump() {
    while (this.running < MAX_RUNNING) {
      const next = this.db.get(null, `SELECT * FROM ai_video_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1`);
      if (!next) return;
      this.db.update('ai_video_jobs', next.id, { status: 'running' });
      this.running++;
      this.run(next)
        .catch((e) => this.db.update('ai_video_jobs', next.id, { status: 'failed', error: String(e.message).slice(0, 400) }))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  async generate(job) {
    const input = [];
    if (job.reference_media_id) {
      const m = getMedia(this.db, job.reference_media_id);
      const buf = m?.data?.length ? m.data : m?.path && fs.existsSync(m.path) ? fs.readFileSync(m.path) : null;
      if (buf && /^image\//.test(m.mime)) input.push({ type: 'image', data: buf.toString('base64'), mime_type: m.mime });
    }
    input.push({ type: 'text', text: job.prompt });
    const res = await this.fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.env.GEMINI_API_KEY },
      body: JSON.stringify({
        model: this.model,
        input: input.length === 1 ? job.prompt : input,
        response_format: { type: 'video', aspect_ratio: job.aspect, duration: `${job.duration}s`, resolution: '720p' },
        store: false,
      }),
      signal: AbortSignal.timeout(12 * 60_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini video ${res.status}: ${data.error?.message || 'error'}${res.status === 404 ? ' — set GEMINI_VIDEO_MODEL to a video model your key can use' : ''}`);
    const out = (data.steps || []).filter((s) => s.type === 'model_output').flatMap((s) => s.content || []).find((c) => c.type === 'video');
    if (out?.data) return Buffer.from(out.data, 'base64');
    if (out?.uri) {
      const r = await this.fetch(out.uri, { headers: { 'x-goog-api-key': this.env.GEMINI_API_KEY } });
      if (!r.ok) throw new Error(`Downloading the generated video failed (${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    }
    throw new Error(data.status && data.status !== 'completed' ? `Generation ${data.status} — the prompt may have been blocked by safety filters; try rewording` : 'No video in the response');
  }

  async run(job) {
    const ws = this.db.byId('workspaces', job.workspace_id);
    const buffer = await this.generate(job);
    const media = await addVideo(this.db, ws, { buffer, mime: 'video/mp4', name: `ai-clip-${job.id.slice(5)}.mp4`, label: `AI · ${job.label}`, dataDir: this.config.dataDir });
    this.db.update('ai_video_jobs', job.id, { status: 'done', media_id: media.id, error: null });
    if (job.asset_id != null && job.scene_index != null) this.assignToScene(job.asset_id, Number(job.scene_index), media.id);
    return media;
  }

  /** Put the clip into the scene — only if the creative is still editable (never touches approved content). */
  assignToScene(assetId, idx, mediaId) {
    const a = this.db.byId('creative_assets', assetId);
    if (!a || !['DRAFT', 'NEEDS_REVISION', 'NEEDS_REVIEW'].includes(a.state)) return;
    const sb = (a.content?.storyboard || []).map((s) => ({ ...s }));
    if (!sb[idx]) return;
    sb[idx].media = { id: mediaId, fit: 'cover', zoom: false, start: 0 };
    this.db.update('creative_assets', a.id, { content: { ...a.content, storyboard: sb } });
  }

  /** Queue clips for chosen scenes of a reel/video. */
  forScenes(asset, ws, { scenes = [], prompts = {}, duration }) {
    if (!['reel', 'video'].includes(asset.format)) throw new HttpError(400, 'AI clips are for reels and short videos');
    const sb = asset.content?.storyboard || [];
    const aspect = CHANNELS[asset.channel]?.formats[asset.format] === '9:16' || asset.aspect_ratio === '9:16' ? '9:16' : '16:9';
    return scenes
      .filter((i) => sb[i])
      .map((i) => {
        const s = sb[i];
        const secs = duration || Math.max(3, Math.min(15, Math.ceil((s.end || 4) - (s.start || 0)) + 1));
        return this.create(ws, { prompt: prompts[i] || scenePrompt(s, ws, aspect), aspect, duration: secs, assetId: asset.id, sceneIndex: i, label: `${asset.title.slice(0, 50)} · scene ${i + 1}` });
      });
  }
}
