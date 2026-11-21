/**
 * Media library: product screenshots / photos a workspace can place in specific video scenes.
 * Workspace brand-kit screenshots appear as virtual items (id `wsshot_<wsId>_<index>`).
 */
import { HttpError, id, nowIso } from '../lib/util.js';

const MAX_BYTES = 6 * 1024 * 1024;
const STOP = new Set(['with', 'your', 'that', 'this', 'from', 'into', 'then', 'they', 'them', 'have', 'more', 'than', 'just', 'what', 'when', 'will', 'shot', 'screen', 'recording', 'visual', 'showing', 'product', 'scene']);
const words = (t) => new Set(String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));

export function listMedia(db, ws) {
  const rows = db.all(null, 'SELECT id, name, label, mime, bytes, created_at FROM media WHERE workspace_id = ? ORDER BY created_at', ws.id);
  const shots = (ws.screenshots || []).map((s, i) => ({ id: `wsshot_${ws.id}_${i}`, name: s.name || `Screenshot ${i + 1}`, label: s.label || s.name || `Screenshot ${i + 1}`, mime: (s.dataUrl.match(/^data:([^;]+)/) || [])[1], brandKit: true }));
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
  const r = db.get(null, 'SELECT mime, data FROM media WHERE id = ?', mediaId);
  return r ? { mime: r.mime, data: Buffer.from(r.data) } : null;
}

export const mediaDataUrl = (db, mediaId) => {
  const m = getMedia(db, mediaId);
  return m ? `data:${m.mime};base64,${m.data.toString('base64')}` : null;
};

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
    if (item) return { item, fit: scene.media.fit || 'contain', zoom: scene.media.zoom !== false, auto: false };
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
  return { item, fit: scene.media?.fit || 'contain', zoom: scene.media?.zoom !== false, auto: true, matched: !!best };
}
