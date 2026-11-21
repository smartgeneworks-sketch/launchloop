/**
 * Media rendering: brand-aware SVG for flyers / post images / carousel slides,
 * an animated SVG preview for reels & short videos, and a structured render job
 * (JSON) that a video renderer (Remotion, FFmpeg pipeline, Shotstack, Creatomate…)
 * can turn into an MP4. SVG keeps the MVP dependency-free and exports cleanly to
 * PNG in the browser.
 */
import { ASPECTS } from '../lib/channels.js';
import { escapeXml as x, wrapText } from '../lib/util.js';
import { stripLinkTokens } from './ai.js';
import { resolveSceneMedia } from './library.js';

const DEFAULT_COLORS = { primary: '#1F2A44', secondary: '#3B4C7A', accent: '#FFB547' };

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrastText = (bg) => (luminance(bg) > 0.45 ? '#111418' : '#FFFFFF');

function theme(workspace) {
  const colors = { ...DEFAULT_COLORS, ...(workspace.brand?.colors || {}) };
  const fonts = workspace.brand?.fonts || {};
  const stack = (f) => `${f ? `'${String(f).replace(/'/g, '')}', ` : ''}Inter, 'Helvetica Neue', Arial, sans-serif`;
  return {
    ...colors,
    fg: contrastText(colors.primary),
    onAccent: contrastText(colors.accent),
    heading: stack(fonts.heading),
    body: stack(fonts.body),
    logo: workspace.brand?.logo || null,
    screenshot: workspace.screenshots?.[0]?.dataUrl || null,
    name: workspace.name || '',
  };
}

const size = (aspect) => ASPECTS[aspect] || ASPECTS['1:1'];

function textBlock(lines, { xPos, y, fs, lh = 1.12, weight = 700, fill, family, anchor = 'start', opacity = 1 }) {
  const tspans = lines.map((l, i) => `<tspan x="${xPos}" dy="${i === 0 ? 0 : fs * lh}">${x(l)}</tspan>`).join('');
  return {
    svg: `<text x="${xPos}" y="${y}" font-family="${x(family)}" font-size="${fs}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" opacity="${opacity}">${tspans}</text>`,
    height: fs * lh * lines.length,
  };
}
const charsFor = (width, fs, k = 0.56) => Math.max(8, Math.floor(width / (fs * k)));

function header(t, W, pad, badge, H = W) {
  const M = Math.min(W, H);
  const logoH = M * 0.065;
  const logo = t.logo
    ? `<image href="${x(t.logo)}" x="${pad}" y="${pad}" height="${logoH}" width="${logoH * 4}" preserveAspectRatio="xMinYMid meet"/>`
    : `<text x="${pad}" y="${pad + logoH * 0.75}" font-family="${x(t.heading)}" font-size="${logoH * 0.7}" font-weight="800" fill="${t.fg}">${x(t.name)}</text>`;
  let b = '';
  if (badge) {
    const fs = M * 0.028;
    const bw = Math.min(W * 0.5, x(badge).length * fs * 0.58 + fs * 2);
    b = `<g><rect x="${W - pad - bw}" y="${pad}" width="${bw}" height="${fs * 2.2}" rx="${fs * 1.1}" fill="${t.accent}"/><text x="${W - pad - bw / 2}" y="${pad + fs * 1.45}" font-family="${x(t.body)}" font-size="${fs}" font-weight="700" fill="${t.onAccent}" text-anchor="middle">${x(badge.slice(0, 40))}</text></g>`;
  }
  return { svg: logo + b, bottom: pad + logoH };
}

function background(t, W, H, aiBg) {
  return `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.primary}"/><stop offset="1" stop-color="${t.secondary}"/></linearGradient>
</defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${aiBg ? `<image href="${x(aiBg)}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice" opacity="0.35"/>` : ''}
  <circle cx="${W * 0.92}" cy="${H * 0.88}" r="${W * 0.32}" fill="${t.accent}" opacity="0.10"/>
  <circle cx="${W * 0.05}" cy="${H * 0.05}" r="${W * 0.18}" fill="#FFFFFF" opacity="0.05"/>`;
}

function screenshotFrame(t, xPos, y, w, h) {
  if (!t.screenshot || h < 60) return '';
  return `<g transform="translate(${xPos},${y})"><defs><clipPath id="shotclip"><rect width="${w}" height="${h}" rx="24"/></clipPath></defs><rect width="${w}" height="${h}" rx="24" fill="#000" opacity="0.25" transform="translate(0,12)"/><rect width="${w}" height="${h}" rx="24" fill="#fff"/><image href="${x(t.screenshot)}" width="${w}" height="${h}" preserveAspectRatio="${t.shotFit === 'contain' ? 'xMidYMid meet' : 'xMidYMin slice'}" clip-path="url(#shotclip)"/></g>`;
}

function ctaPill(t, label, xPos, y, W) {
  const fs = W * 0.034;
  const text = String(label || '').replace(/\s*\(link in bio\)/i, '');
  const w = Math.min(W * 0.8, text.length * fs * 0.6 + fs * 2.6);
  return { svg: `<g><rect x="${xPos}" y="${y}" width="${w}" height="${fs * 2.4}" rx="${fs * 1.2}" fill="${t.accent}"/><text x="${xPos + w / 2}" y="${y + fs * 1.55}" font-family="${x(t.body)}" font-size="${fs}" font-weight="800" fill="${t.onAccent}" text-anchor="middle">${x(text)} →</text></g>`, height: fs * 2.4 };
}

/** Flyer / promo graphic and the image for social posts. */
export function renderImageSvg(asset, workspace, { images = {} } = {}) {
  const t = theme(workspace);
  const cm = asset.content?.media;
  if (cm?.id === 'none') t.screenshot = null;
  else if (cm?.id && images[cm.id]) t.screenshot = images[cm.id];
  else if (!t.screenshot && images.__default) t.screenshot = images.__default;
  t.shotFit = cm?.fit || 'cover';
  const [W, H] = size(asset.aspect_ratio);
  const c = asset.content || {};
  const landscape = W > H * 1.2;
  const pad = Math.round(Math.min(W, H) * 0.07);
  const isFlyer = asset.format === 'flyer';
  const headline = isFlyer ? asset.headline : c.imageHeadline || asset.headline;
  const sub = isFlyer ? c.subhead : c.imageSub;
  const props = isFlyer ? (c.valueProps || []).slice(0, 3) : [];
  const colW = landscape ? (t.screenshot ? W * 0.55 : W - pad * 2) : W - pad * 2;
  const hdr = header(t, W, pad, isFlyer ? c.badge : null, H);
  let y = hdr.bottom + pad * (landscape ? 0.8 : 1.1);
  const parts = [background(t, W, H, c.backgroundImage), hdr.svg];

  const baseFs = landscape ? H * 0.1 : W * (isFlyer ? 0.088 : 0.095);
  let fs = baseFs;
  let lines = wrapText(headline, charsFor(colW, fs));
  while (lines.length > 4 && fs > baseFs * 0.6) {
    fs *= 0.9;
    lines = wrapText(headline, charsFor(colW, fs));
  }
  const h1 = textBlock(lines, { xPos: pad, y: y + fs, fs, weight: 800, fill: t.fg, family: t.heading, lh: 1.05 });
  parts.push(h1.svg);
  y += h1.height + fs * 0.5;

  if (sub) {
    const sfs = fs * 0.36;
    const sb = textBlock(wrapText(sub, charsFor(colW, sfs, 0.5)).slice(0, 3), { xPos: pad, y: y + sfs, fs: sfs, weight: 500, fill: t.fg, family: t.body, lh: 1.3, opacity: 0.85 });
    parts.push(sb.svg);
    y += sb.height + sfs * 0.9;
  }
  for (const p of props) {
    const pfs = Math.min(fs * 0.34, W * 0.036);
    const pl = wrapText(p, charsFor(colW - pfs * 2, pfs, 0.5)).slice(0, 2);
    parts.push(`<circle cx="${pad + pfs * 0.55}" cy="${y + pfs * 0.65}" r="${pfs * 0.55}" fill="${t.accent}"/><path d="M${pad + pfs * 0.3} ${y + pfs * 0.65} l${pfs * 0.18} ${pfs * 0.18} l${pfs * 0.32} -${pfs * 0.36}" stroke="${t.onAccent}" stroke-width="${pfs * 0.12}" fill="none" stroke-linecap="round"/>`);
    const tb = textBlock(pl, { xPos: pad + pfs * 1.6, y: y + pfs, fs: pfs, weight: 600, fill: t.fg, family: t.body, lh: 1.25 });
    parts.push(tb.svg);
    y += tb.height + pfs * 0.6;
  }

  const ctaY = H - pad - W * 0.034 * 2.4 - (c.footer ? W * 0.04 : 0);
  if (landscape) parts.push(screenshotFrame(t, W * 0.6, pad * 1.6, W * 0.4 - pad, H - pad * 3.2));
  else parts.push(screenshotFrame(t, pad, y + pad * 0.3, W - pad * 2, ctaY - y - pad * 1.0));
  parts.push(ctaPill(t, asset.cta, pad, ctaY, W).svg);
  if (c.footer) parts.push(`<text x="${pad}" y="${H - pad * 0.6}" font-family="${x(t.body)}" font-size="${W * 0.024}" fill="${t.fg}" opacity="0.7">${x(c.footer)}</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`;
}

export function renderSlideSvg(asset, workspace, index = 0) {
  const t = theme(workspace);
  const [W, H] = size(asset.aspect_ratio);
  const slides = asset.content?.slides || [];
  const i = Math.max(0, Math.min(index, slides.length - 1));
  const s = slides[i] || { title: asset.headline, body: '' };
  const pad = W * 0.08;
  const last = i === slides.length - 1;
  const parts = [background(t, W, H), header(t, W, pad).svg];
  parts.push(`<text x="${W - pad}" y="${pad + W * 0.045}" font-family="${x(t.body)}" font-size="${W * 0.03}" fill="${t.fg}" opacity="0.7" text-anchor="end">${i + 1}/${slides.length}</text>`);
  let fs = W * (i === 0 ? 0.095 : 0.075);
  let lines = wrapText(s.title, charsFor(W - pad * 2, fs));
  while (lines.length > 4) {
    fs *= 0.9;
    lines = wrapText(s.title, charsFor(W - pad * 2, fs));
  }
  let y = H * 0.32;
  const h = textBlock(lines, { xPos: pad, y, fs, weight: 800, fill: t.fg, family: t.heading, lh: 1.05 });
  parts.push(h.svg);
  y += h.height + fs * 0.4;
  const bfs = W * 0.042;
  parts.push(textBlock(wrapText(s.body, charsFor(W - pad * 2, bfs, 0.5)).slice(0, 6), { xPos: pad, y: y + bfs, fs: bfs, weight: 500, fill: t.fg, family: t.body, lh: 1.35, opacity: 0.88 }).svg);
  if (last) parts.push(ctaPill(t, asset.cta, pad, H - pad - W * 0.09, W).svg);
  else parts.push(`<text x="${W - pad}" y="${H - pad}" font-family="${x(t.body)}" font-size="${W * 0.034}" font-weight="700" fill="${t.accent}" text-anchor="end">Swipe →</text>`);
  const dots = slides.map((_, k) => `<circle cx="${W / 2 + (k - (slides.length - 1) / 2) * W * 0.03}" cy="${H - pad * 0.45}" r="${W * 0.007}" fill="${t.fg}" opacity="${k === i ? 1 : 0.35}"/>`).join('');
  parts.push(dots);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>`;
}

/** Animated storyboard preview (SMIL) — a faithful stand-in until a real render. */
export function renderVideoPreviewSvg(asset, workspace, { library = [], images = {} } = {}) {
  const t = theme(workspace);
  const [W, H] = size(asset.aspect_ratio);
  const sb = asset.content?.storyboard || [];
  const D = asset.content?.durationSec || sb.at(-1)?.end || 20;
  const pad = Math.min(W, H) * 0.07;
  const vertical = H > W;
  const chipY = header(t, W, pad, null, H).bottom + Math.min(W, H) * 0.03;
  const scenes = sb
    .map((s, si) => {
      const pickm = resolveSceneMedia(s, si, library);
      const img = pickm && images[pickm.item.id];
      const k0 = (s.start / D).toFixed(4);
      const k1 = (s.end / D).toFixed(4);
      const anim =
        s.start === 0
          ? `<animate attributeName="opacity" calcMode="discrete" keyTimes="0;${k1}" values="1;0" dur="${D}s" repeatCount="indefinite"/>`
          : s.end >= D
            ? `<animate attributeName="opacity" calcMode="discrete" keyTimes="0;${k0}" values="0;1" dur="${D}s" repeatCount="indefinite"/>`
            : `<animate attributeName="opacity" calcMode="discrete" keyTimes="0;${k0};${k1}" values="0;1;0" dur="${D}s" repeatCount="indefinite"/>`;
      const fs = vertical ? W * 0.085 : H * 0.075;
      const lines = wrapText(s.onScreenText, charsFor(W - pad * 2, fs));
      const vfs = W * (vertical ? 0.03 : 0.018);
      const sfs = W * (vertical ? 0.036 : 0.022);
      const sub = wrapText(s.vo, charsFor(W - pad * 2.4, sfs, 0.5)).slice(0, 3);
      const headY = Math.max(vertical ? H * 0.28 : 0, chipY + vfs * 1.9 + fs * 1.15);
      const head = textBlock(lines.slice(0, vertical ? 5 : 3), { xPos: W / 2, y: headY, fs, weight: 800, fill: t.fg, family: t.heading, anchor: 'middle', lh: 1.05 });
      const frameY = headY + head.height - fs * 0.55;
      const subTop = H - pad * 1.6 - sfs * 1.35 * sub.length - sfs;
      const frameH = Math.max(0, Math.min(vertical ? H * 0.32 : H * 0.3, subTop - frameY - pad * 0.4));
      const mm = (n) => `0:${String(n).padStart(2, '0')}`;
      return `<g opacity="${s.start === 0 ? 1 : 0}">${anim}
        <rect x="${pad}" y="${chipY}" rx="${vfs * 0.9}" width="${vfs * 13}" height="${vfs * 1.9}" fill="${t.accent}"/>
        <text x="${pad + vfs * 0.8}" y="${chipY + vfs * 1.3}" font-family="${x(t.body)}" font-size="${vfs}" font-weight="800" fill="${t.onAccent}">${x(String(s.type || '').toUpperCase())} · ${mm(s.start)}–${mm(s.end)}</text>
        ${head.svg}
        ${img && frameH > 40
          ? `<defs><clipPath id="sc${si}"><rect x="${pad}" y="${frameY}" width="${W - pad * 2}" height="${frameH}" rx="24"/></clipPath></defs>
             <g clip-path="url(#sc${si})"><rect x="${pad}" y="${frameY}" width="${W - pad * 2}" height="${frameH}" fill="#0b0d12" fill-opacity="0.35"/>
             <image href="${x(img)}" x="${pad}" y="${frameY}" width="${W - pad * 2}" height="${frameH}" preserveAspectRatio="${pickm.fit === 'cover' ? 'xMidYMin slice' : 'xMidYMid meet'}" ${s.type === 'hook' && pickm.auto ? 'opacity="0.45"' : ''}/></g>`
          : `<rect x="${pad}" y="${frameY}" width="${W - pad * 2}" height="${frameH}" rx="24" fill="#000" fill-opacity="0.22" stroke="${t.fg}" stroke-opacity="0.35" stroke-dasharray="14 10" stroke-width="3"/>
        ${textBlock(wrapText('▶ ' + s.shot, charsFor(W - pad * 3, vfs, 0.5)).slice(0, 2), { xPos: W / 2, y: frameY + frameH / 2 - vfs * 0.4, fs: vfs, weight: 700, fill: t.fg, family: t.body, anchor: 'middle', lh: 1.3 }).svg}
        ${textBlock(wrapText(s.visual, charsFor(W - pad * 3, vfs * 0.85, 0.5)).slice(0, 2), { xPos: W / 2, y: frameY + frameH / 2 + vfs * 2.2, fs: vfs * 0.85, weight: 400, fill: t.fg, family: t.body, anchor: 'middle', lh: 1.3, opacity: 0.75 }).svg}`}
        <rect x="${pad}" y="${H - pad * 1.6 - sfs * 1.35 * sub.length - sfs}" width="${W - pad * 2}" height="${sfs * 1.35 * sub.length + sfs * 0.9}" rx="16" fill="#000" fill-opacity="0.55"/>
        ${textBlock(sub, { xPos: W / 2, y: H - pad * 1.6 - sfs * 1.35 * sub.length + sfs * 0.1, fs: sfs, weight: 600, fill: '#FFFFFF', family: t.body, anchor: 'middle', lh: 1.35 }).svg}
      </g>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${background(t, W, H)}${header(t, W, pad, null, H).svg}${scenes}
  <rect x="0" y="${H - 10}" width="0" height="10" fill="${t.accent}"><animate attributeName="width" from="0" to="${W}" dur="${D}s" repeatCount="indefinite"/></rect></svg>`;
}

export function renderAssetSvg(rawAsset, workspace, { slide = 0, fontCss = '', library = [], images = {} } = {}) {
  const asset = { ...rawAsset, headline: String(rawAsset.headline || '').replace(/\s*\{\{\s*link\s*\}\}\s*/gi, ' ').trim(), content: stripLinkTokens(rawAsset.content || {}) };
  let svg;
  if (asset.format === 'reel' || asset.format === 'video') svg = renderVideoPreviewSvg(asset, workspace, { library, images });
  else if (asset.format === 'carousel') svg = renderSlideSvg(asset, workspace, slide);
  else svg = renderImageSvg(asset, workspace, { images });
  return fontCss ? svg.replace(/^(<svg[^>]*>)/, `$1<defs><style>${fontCss}</style></defs>`) : svg;
}

/** Renderer-agnostic video render job. Feed it to Remotion / FFmpeg / a render API. */
export function buildRenderJob(rawAsset, workspace, { publicBaseUrl = '' } = {}) {
  const asset = { ...rawAsset, content: stripLinkTokens(rawAsset.content || {}) };
  const [W, H] = size(asset.aspect_ratio);
  const c = asset.content || {};
  const t = theme(workspace);
  return {
    schema: 'launchloop.render-job/v1',
    assetId: asset.id,
    version: asset.version,
    status: 'ready_to_render',
    composition: { width: W, height: H, fps: 30, durationSec: c.durationSec || 20, aspectRatio: asset.aspect_ratio },
    brand: { colors: { primary: t.primary, secondary: t.secondary, accent: t.accent }, fonts: workspace.brand?.fonts || {}, logo: workspace.brand?.logo ? `${publicBaseUrl}/api/workspaces/${workspace.id}/logo` : null },
    scenes: (c.storyboard || []).map((s) => ({
      index: s.scene,
      start: s.start,
      end: s.end,
      type: s.type,
      layout: s.type === 'demo' || s.type === 'proof' ? 'footage-with-caption' : 'kinetic-text',
      text: s.onScreenText,
      shot: s.shot,
      footage: { kind: /screen/i.test(s.shot) ? 'screen_recording' : /split/i.test(s.shot) ? 'split_screen' : 'generated_background', placeholder: s.visual, src: null },
      transition: 'cut',
    })),
    voiceover: { text: c.voiceover || '', language: workspace.locale?.language || 'en', voice: 'neutral-energetic', provider: null },
    captions: (c.captions || []).map((k) => ({ start: k.start, end: k.end, text: k.text })),
    music: { mood: c.musicMood || 'upbeat', src: null },
    outputs: [{ container: 'mp4', codec: 'h264', path: `renders/${asset.id}-v${asset.version}.mp4` }],
    preview: `${publicBaseUrl}/api/assets/${asset.id}/media.svg`,
  };
}
