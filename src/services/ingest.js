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
  return {
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
  return { pages, extracted, notes };
}
