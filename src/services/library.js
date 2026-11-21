/**
 * Media library: product screenshots / photos a workspace can place in specific video scenes.
 * Workspace brand-kit screenshots appear as virtual items (id `wsshot_<wsId>_<index>`).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError, id, nowIso } from '../lib/util.js';

const VIDEO_TYPES = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-m4v': 'm4v' };
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-300) || `${cmd} exited ${code}`))));
  });

const MAX_BYTES = 6 * 1024 * 1024;
const STOP = new Set(['with', 'your', 'that', 'this', 'from', 'into', 'then', 'they', 'them', 'have', 'more', 'than', 'just', 'what', 'when', 'will', 'shot', 'screen', 'recording', 'visual', 'showing', 'product', 'scene']);
const words = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));

export function listMedia(db, ws) {
  const rows = db.all(null, 'SELECT id, name, label, mime, bytes, kind, duration, poster, width, height, created_at FROM media WHERE workspace_id = ? ORDER BY created_at', ws.id).map((r) => ({ ...r, kind: r.kind || 'image', posterUrl: r.poster ? `/api/media/${r.id}/poster` : null, poster: undefined }));
  const shots = (ws.screenshots || []).map((s, i) => ({ kind: 'image', id: `wsshot_${ws.id}_${i}`, name: s.name || `Screenshot ${i + 1}`, label: s.label || s.name || `Screenshot ${i + 1}`, mime: (s.dataUrl.match(/^data:([^;]+)/) || [])[1], brandKit: true }));
  return [...shots, ...rows].map((m) => ({ ...m, url: `/api/media/${m.id}` }));
}

export function addMedia(db, ws, { name, label, dataUrl }) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:png|jpe?g|webp|gif|svg\+xml));base64,(.+)$/);
  if (!m) throw new HttpError(400, 'Upload a PNG, JPG, WebP, GIF or SVG image');
  const data = Buffer.from(m[2], 'base64');
  if (data.length > MAX_BYTES) throw new HttpError(413, 'Images must be under 6 MB');
  const row = { id: id('med'), workspace_id: ws.id, name: String(name || 'image').slice(0, 120), label: String(label || name || '').slice(0, 160), mime: m[1], bytes: data.length, data, created_at: nowIso() };
  db.insert('media', row);
  const { data: _d, ...meta } = row;
  return { ...meta, url: `/api/media/${row.id}` };
}

/** Returns { mime, data:Buffer } for a library item or brand-kit screenshot. */
export function getMedia(db, mediaId) {
  const ws = mediaId.match(/^wsshot_(ws_[a-f0-9]+)_(\d+)$/);
  if (ws) {
    const w = db.byId('workspaces', ws[1]);
    const s = w?.screenshots?.[Number(ws[2])];
    const mm = s?.dataUrl?.match(/^data:([^;]+);base64,(.+)$/);
    if (!mm) return null;
    return { mime: mm[1], data: Buffer.from(mm[2], 'base64') };
  }
  const r = db.get(null, 'SELECT mime, data, path, kind, poster FROM media WHERE id = ?', mediaId);
  if (!r) return null;
  if (r.path) return { mime: r.mime, path: r.path, kind: r.kind, poster: r.poster };
  return { mime: r.mime, data: Buffer.from(r.data) };
}

/** Data URL for embedding in SVG previews (videos use their poster frame). */
export const mediaDataUrl = (db, mediaId) => {
  const m = getMedia(db, mediaId);
  if (!m) return null;
  if (m.kind === 'video' || m.kind === 'final') return m.poster && fs.existsSync(m.poster) ? `data:image/jpeg;base64,${fs.readFileSync(m.poster).toString('base64')}` : null;
  if (m.path) return fs.existsSync(m.path) ? `data:${m.mime};base64,${fs.readFileSync(m.path).toString('base64')}` : null;
  return `data:${m.mime};base64,${m.data.toString('base64')}`;
};

/**
 * Store an uploaded video clip on disk. If ffmpeg is available the clip is converted to
 * H.264 MP4 (≤1080p, 30 fps, no audio — scenes get voiceover/music instead) so every
 * browser can play it, and a poster frame is extracted for previews.
 */
export async function addVideo(db, ws, { buffer, mime, name, label, dataDir }) {
  const ext = VIDEO_TYPES[String(mime).split(';')[0]];
  if (!ext) throw new HttpError(400, 'Upload an MP4, MOV or WebM video');
  if (!buffer?.length) throw new HttpError(400, 'Empty file');
  if (buffer.length > MAX_VIDEO_BYTES) throw new HttpError(413, 'Videos must be under 80 MB — trim it to the few seconds you need');
  const dir = path.join(dataDir, 'media');
  fs.mkdirSync(dir, { recursive: true });
  const mid = id('med');
  const original = path.join(dir, `${mid}-orig.${ext}`);
  fs.writeFileSync(original, buffer);
  let file = original;
  let outMime = mime;
  let duration = null;
  let poster = null;
  try {
    const mp4 = path.join(dir, `${mid}.mp4`);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', original, '-vf', "scale='min(1920,iw)':-2,fps=30", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', mp4]);
    fs.rmSync(original, { force: true });
    file = mp4;
    outMime = 'video/mp4';
    duration = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4])).trim()) || null;
    poster = path.join(dir, `${mid}-poster.jpg`);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.min(0.5, (duration || 1) / 2)), '-i', mp4, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '4', poster]);
  } catch (e) {
    console.warn(`[media] ffmpeg unavailable or failed (${e.message.slice(0, 120)}) — storing the original clip`);
    if (poster && !fs.existsSync(poster)) poster = null;
  }
  const bytes = fs.statSync(file).size;
  db.insert('media', { id: mid, workspace_id: ws.id, name: String(name || 'clip').slice(0, 120), label: String(label || name || '').slice(0, 160), mime: outMime, bytes, data: Buffer.alloc(0), path: file, kind: 'video', duration, poster, created_at: nowIso() });
  return { id: mid, name, label, mime: outMime, bytes, kind: 'video', duration, posterUrl: poster ? `/api/media/${mid}/poster` : null, url: `/api/media/${mid}` };
}

export function deleteMedia(db, mediaId) {
  const r = db.get(null, 'SELECT path, poster FROM media WHERE id = ?', mediaId);
  for (const f of [r?.path, r?.poster]) if (f) fs.rmSync(f, { force: true });
  db.run('DELETE FROM media WHERE id = ?', mediaId);
}

/**
 * Which image a scene shows. Explicit choice wins ('none' = brand background);
 * otherwise auto-match the scene's words against image labels; otherwise rotate
 * through the library for demo/proof/problem scenes.
 */
export function resolveSceneMedia(scene, index, library) {
  const choice = scene.media?.id;
  if (choice === 'none') return null;
  if (choice && choice !== 'auto') {
    const item = library.find((m) => m.id === choice);
    if (item) return { item, fit: scene.media.fit || 'contain', zoom: scene.media.zoom ?? item.kind !== 'video', start: Number(scene.media.start) || 0, auto: false };
  }
  if (!library.length || scene.type === 'cta') return null;
  const sceneWords = words(`${scene.onScreenText} ${scene.vo} ${scene.visual} ${scene.shot}`);
  let best = null;
  let bestScore = 0;
  for (const m of library) {
    const score = [...words(`${m.label} ${m.name}`)].filter((w) => sceneWords.has(w)).length;
    if (score > bestScore) (best = m), (bestScore = score);
  }
  const item = best || library[index % library.length];
  return { item, fit: scene.media?.fit || 'contain', zoom: scene.media?.zoom ?? item.kind !== 'video', start: Number(scene.media?.start) || 0, auto: true, matched: !!best };
}

/**
 * Finished videos (made elsewhere) keep their audio. H.264/AAC MP4s are only remuxed for
 * fast start; anything else is converted. The file arrives already streamed to disk.
 */
export async function addFinalVideo(db, ws, { tmpPath, mime, name, label, dataDir }) {
  const dir = path.join(dataDir, 'media');
  fs.mkdirSync(dir, { recursive: true });
  const mid = id('med');
  const out = path.join(dir, `${mid}.mp4`);
  let width = null;
  let height = null;
  let duration = null;
  let poster = null;
  let finalPath = out;
  let outMime = 'video/mp4';
  try {
    const probe = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration,format_name', '-of', 'json', tmpPath]));
    const v = probe.streams.find((x) => x.codec_type === 'video');
    const a = probe.streams.find((x) => x.codec_type === 'audio');
    if (!v) throw new HttpError(400, 'That file has no video track');
    width = v.width;
    height = v.height;
    duration = Number(probe.format?.duration) || null;
    const compatible = /mp4|mov/.test(probe.format?.format_name || '') && v.codec_name === 'h264' && (!a || a.codec_name === 'aac');
    const scale = "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'";
    await run('ffmpeg', compatible ? ['-y', '-v', 'error', '-i', tmpPath, '-c', 'copy', '-movflags', '+faststart', out] : ['-y', '-v', 'error', '-i', tmpPath, '-vf', scale, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out]);
    fs.rmSync(tmpPath, { force: true });
    poster = path.join(dir, `${mid}-poster.jpg`);
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.min(1, (duration || 2) / 2)), '-i', out, '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '4', poster]);
  } catch (e) {
    if (e instanceof HttpError) {
      fs.rmSync(tmpPath, { force: true });
      throw e;
    }
    console.warn(`[media] ffmpeg unavailable or failed (${String(e.message).slice(0, 120)}) — storing the original file`);
    if (!fs.existsSync(out)) {
      finalPath = path.join(dir, `${mid}-orig${path.extname(name || '') || '.mp4'}`);
      fs.renameSync(tmpPath, finalPath);
      outMime = mime || 'video/mp4';
    }
    if (poster && !fs.existsSync(poster)) poster = null;
  }
  const bytes = fs.statSync(finalPath).size;
  db.insert('media', { id: mid, workspace_id: ws.id, name: String(name || 'video').slice(0, 120), label: String(label || name || '').slice(0, 160), mime: outMime, bytes, data: Buffer.alloc(0), path: finalPath, kind: 'final', duration, poster, width, height, created_at: nowIso() });
  return { id: mid, name, label, mime: outMime, bytes, kind: 'final', duration, width, height, posterUrl: poster ? `/api/media/${mid}/poster` : null, url: `/api/media/${mid}` };
}
