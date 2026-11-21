/**
 * Authorized source ingestion. Fetches only the URL the user gave us (plus up to
 * a few same-site pages listed in its sitemap), honours robots.txt for our
 * user agent, refuses private/internal hosts (SSRF guard), and caps size/time.
 * If a site disallows us or can't be reached, the UI offers manual paste.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from '../lib/util.js';

export const USER_AGENT = 'LaunchLoopBot/0.1 (+https://github.com/your-org/launchloop; user-initiated product import)';
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8000;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
}

export async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'Enter a full URL, e.g. https://example.com');
  }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Only http(s) URLs can be imported');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname)) throw new HttpError(400, 'Internal hostnames cannot be imported');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpError(422, `Could not resolve ${u.hostname}. Paste your product details manually instead.`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new HttpError(400, 'Private network addresses cannot be imported');
  return u;
}

async function fetchText(url, { accept = 'text/html' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept }, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return { ok: false, status: res.status, text: '' };
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        ctrl.abort();
        break;
      }
      chunks.push(value);
    }
    return { ok: true, status: res.status, text: Buffer.concat(chunks).toString('utf8'), finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal robots.txt evaluation: groups for our UA (or *), longest-match Allow/Disallow. */
export function robotsAllows(robotsTxt, pathname, ua = 'launchloopbot') {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(robotsTxt || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const [, key, val] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (key === 'user-agent') {
      if (!lastWasAgent || !cur) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const applicable = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const r of applicable.flatMap((g) => g.rules)) {
    if (!r.path) continue; // "Disallow:" (empty) allows everything
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathname) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

const decode = (s) =>
  String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = (s) => decode(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function extractFromHtml(html) {
  const clean = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const meta = (name) => {
    const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i');
    const tag = clean.match(re)?.[0];
    return tag ? decode(tag.match(/content=["']([^"']*)["']/i)?.[1] || '') : '';
  };
  const all = (tag, n) => [...clean.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi'))].map((m) => strip(m[1])).filter(Boolean).slice(0, n);
  const body = strip(clean.match(/<body[\s\S]*<\/body>/i)?.[0] || clean);
  const styles = [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n') + [...String(html).matchAll(/style="([^"]*)"/gi)].map((m) => m[1]).join(';');
  const googleFonts = [...String(html).matchAll(/fonts\.googleapis\.com\/css2?\?([^"'\s>]+)/gi)].flatMap((m) => [...decode(m[1]).matchAll(/family=([^:&]+)/g)].map((f) => decodeURIComponent(f[1]).replace(/\+/g, ' ')));
  const stylesheets = [...String(html).matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)].map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1]).filter(Boolean);
  return {
    googleFonts,
    stylesheets,
    css: styles.slice(0, 200_000),
    title: strip(clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ''),
    description: meta('description') || meta('og:description'),
    ogSiteName: meta('og:site_name'),
    ogImage: meta('og:image'),
    themeColor: meta('theme-color'),
    headings: [...all('h1', 3), ...all('h2', 10), ...all('h3', 10)],
    listItems: all('li', 60).filter((t) => t.length > 12 && t.length < 160),
    prices: [...new Set(body.match(/(?:[$€£]\s?\d[\d,.]*(?:\s?\/\s?(?:mo|month|yr|year|user))?)/gi) || [])].slice(0, 5),
    text: body.slice(0, 8000),
  };
}

/** Fetch a site the user owns/points at. Returns { pages, extracted, notes } or throws with a helpful message. */
export async function ingestUrl(rawUrl) {
  const u = await assertPublicUrl(rawUrl);
  const notes = [];
  const robots = await fetchText(new URL('/robots.txt', u.origin), { accept: 'text/plain' });
  const robotsTxt = robots.ok ? robots.text : '';
  if (!robots.ok) notes.push('No robots.txt found — treating site as allowed.');
  if (!robotsAllows(robotsTxt, u.pathname || '/')) {
    throw new HttpError(403, `robots.txt on ${u.hostname} disallows automated access to ${u.pathname}. Paste your product details manually instead.`, { robots: true });
  }
  const main = await fetchText(u.toString());
  if (!main.ok) throw new HttpError(502, `Could not fetch ${u.toString()} (${main.error || 'HTTP ' + main.status}). Paste your product details manually instead.`);
  const extracted = extractFromHtml(main.text);
  const pages = [{ url: u.toString(), title: extracted.title }];

  // Optional: up to 3 same-origin pages from the sitemap that look like features/pricing/about.
  const sitemapUrl = robotsTxt.match(/^\s*sitemap:\s*(\S+)/im)?.[1] || new URL('/sitemap.xml', u.origin).toString();
  try {
    const sm = new URL(sitemapUrl);
    if (sm.origin === u.origin) {
      const s = await fetchText(sm.toString(), { accept: 'application/xml' });
      const locs = s.ok ? [...s.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]) : [];
      const wanted = locs.filter((l) => /feature|pricing|about|product|how-it-works/i.test(l)).filter((l) => new URL(l).origin === u.origin).slice(0, 3);
      for (const l of wanted) {
        if (!robotsAllows(robotsTxt, new URL(l).pathname)) continue;
        const p = await fetchText(l);
        if (!p.ok) continue;
        const ex = extractFromHtml(p.text);
        pages.push({ url: l, title: ex.title });
        extracted.headings.push(...ex.headings.slice(0, 6));
        extracted.listItems.push(...ex.listItems.slice(0, 20));
        extracted.prices.push(...ex.prices);
        extracted.text += '\n' + ex.text.slice(0, 3000);
      }
      if (wanted.length) notes.push(`Also read ${pages.length - 1} page(s) listed in the sitemap.`);
    }
  } catch {
    /* sitemap optional */
  }
  extracted.prices = [...new Set(extracted.prices)].slice(0, 5);
  // Up to 2 same-origin stylesheets for the brand theme (fonts + colours).
  for (const href of (extracted.stylesheets || []).slice(0, 4)) {
    try {
      const cssUrl = new URL(href, u);
      if (cssUrl.origin !== u.origin || !robotsAllows(robotsTxt, cssUrl.pathname)) continue;
      const r = await fetchText(cssUrl.toString(), { accept: 'text/css' });
      if (r.ok) extracted.css += '\n' + r.text.slice(0, 400_000);
      if (extracted.css.length > 600_000) break;
    } catch {}
  }
  extracted.brandSuggestion = suggestBrand(extracted);
  return { pages, extracted, notes };
}

// ---------------------------------------------------------------- brand theme from site
import { FONTS, PAIRINGS, fontByName } from '../lib/fonts.js';

function hexToHsl(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d) hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (hue * 60 + 360) % 360, s, l };
}
const norm = (hex) => {
  let h = hex.toLowerCase().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h;
};
function shade(hex, amt) {
  const h = norm(hex).slice(1);
  const ch = [0, 2, 4].map((i) => Math.max(0, Math.min(255, Math.round(parseInt(h.slice(i, i + 2), 16) * (1 + amt)))));
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Suggest brand colours + fonts from a site's CSS (never applied automatically). */
export function suggestBrand(ex) {
  const css = String(ex.css || '');
  const counts = new Map();
  for (const m of css.matchAll(/#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const c = norm(m[0]);
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  const colourful = [...counts.entries()]
    .map(([c, n]) => ({ c, n, ...hexToHsl(c) }))
    .filter((x) => x.s > 0.22 && x.l > 0.08 && x.l < 0.9)
    .sort((a, b) => b.n - a.n);
  let primary = ex.themeColor && /^#[0-9a-f]{3,6}$/i.test(ex.themeColor) ? norm(ex.themeColor) : null;
  if (!primary) primary = (colourful.find((x) => x.l < 0.5) || colourful[0])?.c || null;
  const ph = primary ? hexToHsl(primary) : null;
  const accent = colourful.find((x) => x.c !== primary && x.l >= 0.45 && (!ph || Math.abs(x.h - ph.h) > 25))?.c || colourful.find((x) => x.c !== primary)?.c || null;
  const colors = primary ? { primary, secondary: shade(primary, ph.l < 0.35 ? 0.45 : -0.25), accent: accent || '#FFB547' } : null;

  const families = [...(ex.googleFonts || []), ...[...css.matchAll(/font-family\s*:\s*([^;}{]+)/gi)].map((m) => m[1].split(',')[0].replace(/["']/g, '').trim())];
  const detected = [...new Set(families.filter((f) => f && !/^(inherit|initial|var\(|-apple-system|system-ui|sans-serif|serif|monospace|ui-)/i.test(f)))];
  const known = detected.map((f) => fontByName(f)?.name).filter(Boolean);
  let fonts = null;
  if (known.length) {
    const heading = known.find((n) => ['display', 'serif'].includes(fontByName(n).cat)) || known[0];
    const body = known.find((n) => n !== heading && fontByName(n).cat === 'sans') || (fontByName(heading).cat === 'sans' ? heading : 'Inter');
    fonts = { heading, body };
  }
  return { colors, fonts, detectedFonts: detected.slice(0, 6) };
}

export { FONTS, PAIRINGS };
