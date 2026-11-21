/**
 * Self-hosts brand fonts: fetches the Latin subset of a Google Font once, caches the
 * woff2 files on disk and serves @font-face CSS with data URLs. Embedding the fonts
 * means SVG flyers, PNG exports and recorded videos render in the real brand font
 * (an SVG shown as an image can't load external fonts). Falls back silently to
 * system fonts if Google can't be reached.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fontByName } from '../lib/fonts.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Keep only the Latin @font-face block for each weight from a css2 response. */
export function latinBlocks(css) {
  const out = [];
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;
  let m;
  while ((m = re.exec(css))) if (m[1] === 'latin') out.push(m[2]);
  if (!out.length) out.push(...(css.match(/@font-face\s*\{[^}]*\}/g) || []));
  return out;
}

export class FontService {
  constructor({ dataDir = './data', fetchImpl = globalThis.fetch } = {}) {
    this.dir = path.join(dataDir, 'fonts');
    this.fetch = fetchImpl;
    this.mem = new Map();
    this.failed = new Map();
  }

  async family(name) {
    const f = fontByName(name);
    if (!f) return '';
    if (this.mem.has(f.name)) return this.mem.get(f.name);
    const file = path.join(this.dir, `${crypto.createHash('md5').update(f.name).digest('hex')}.css`);
    if (fs.existsSync(file)) {
      const css = fs.readFileSync(file, 'utf8');
      this.mem.set(f.name, css);
      return css;
    }
    if (Date.now() - (this.failed.get(f.name) || 0) < 10 * 60_000) return '';
    try {
      const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.name).replace(/%20/g, '+')}:wght@${f.weights.join(';')}&display=swap`;
      const res = await this.fetch(url, { headers: { 'user-agent': UA } });
      if (!res.ok) throw new Error(`google fonts ${res.status}`);
      const blocks = latinBlocks(await res.text());
      const embedded = [];
      for (const b of blocks) {
        const src = b.match(/url\((https:[^)]+)\)/)?.[1];
        if (!src) continue;
        const r = await this.fetch(src, { headers: { 'user-agent': UA } });
        if (!r.ok) continue;
        const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
        embedded.push(b.replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${b64}) format('woff2');`).replace(/\s+/g, ' '));
      }
      const css = embedded.join('\n');
      if (!css) throw new Error('no font files');
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(file, css);
      this.mem.set(f.name, css);
      return css;
    } catch (e) {
      console.warn(`[fonts] ${f.name}: ${e.message} — using system fonts`);
      this.failed.set(f.name, Date.now());
      return '';
    }
  }

  /** @font-face CSS for a workspace's heading + body fonts. */
  async forWorkspace(ws) {
    const names = [...new Set([ws.brand?.fonts?.heading, ws.brand?.fonts?.body].filter(Boolean))];
    return (await Promise.all(names.map((n) => this.family(n)))).filter(Boolean).join('\n');
  }
}
