/**
 * Deterministic, template-based generator used when no AI key is configured
 * (and as the shape-normaliser / fallback for AI output). It only uses facts
 * the user supplied — it never invents statistics, testimonials or user counts.
 */
import { CHANNELS, FORMATS } from '../lib/channels.js';
import { capitalize, pick, rng, shuffle, slugify, wordCount } from '../lib/util.js';

const lower = (s) => String(s || '').replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase());
const trimEnd = (s) => String(s || '').trim().replace(/[.!]+$/, '');
const short = (s, n = 6) => String(s || '').split(/\s+/).slice(0, n).join(' ');

function ctx(workspace) {
  const features = (workspace.features?.length ? workspace.features : [{ name: 'Core workflow', benefit: workspace.tagline || 'Get more done in less time' }]).map(
    (f) => (typeof f === 'string' ? { name: short(f, 4), benefit: f } : f),
  );
  return {
    P: workspace.name || 'Our product',
    tagline: workspace.tagline || features[0].benefit,
    features,
    valueProps: workspace.value_props?.length ? workspace.value_props : features.map((f) => f.benefit),
    pains: workspace.pain_points?.length ? workspace.pain_points : ['doing it all by hand'],
    audience: workspace.audience || 'busy teams',
    offer: workspace.offer || '',
    referral: workspace.referral_mechanics || '',
    tone: workspace.locale?.tone || 'friendly',
    domain: (() => {
      try {
        return new URL(workspace.website_url).hostname.replace(/^www\./, '');
      } catch {
        return '';
      }
    })(),
  };
}

const ANGLES = [
  { key: 'pain', name: 'Pain-first', hook: (c, f, pain) => `Stop ${lower(trimEnd(pain))}. Watch this.` },
  { key: 'pov', name: 'POV', hook: (c, f, pain) => `POV: you stopped ${lower(trimEnd(pain))}.` },
  { key: 'beforeafter', name: 'Before / After', hook: (c, f, pain) => `Before vs. after ${c.P}: ${lower(trimEnd(pain))} → ${lower(f.name)}.` },
  { key: 'demo', name: 'Feature demo', hook: (c, f) => `${f.name} in 15 seconds — watch.` },
  { key: 'steps', name: '3-step workflow', hook: (c, f, pain) => `The 3-step ${c.P} setup that replaces ${lower(trimEnd(pain))}.` },
  { key: 'callout', name: 'Audience call-out', hook: (c, f, pain) => `${capitalize(String(c.audience).split(/\s+/).slice(-2).join(' '))}: still ${lower(trimEnd(pain))}?` },
];

function ctaFor(c, channel) {
  const base = { friendly: 'Try it free', direct: 'Start free today', formal: 'Request your free trial', playful: 'Take it for a spin' }[c.tone] || 'Try it free';
  const offer = c.offer ? ` — ${c.offer}` : '';
  return CHANNELS[channel]?.linkInCaption === false ? `${base}${offer} (link in bio)` : `${base}${offer}`;
}

function shareLine(c, r, pain) {
  const opts = [];
  if (/invite|refer|referral|credit|month/i.test(c.referral)) opts.push(/^(invite|refer)/i.test(c.referral.trim()) ? `${capitalize(trimEnd(c.referral.trim()))}.` : `Invite a teammate — ${lower(trimEnd(c.referral))}.`);
  if (/template|share|public link|embed/i.test(c.referral)) opts.push(`Grab the shareable template and send it to your team.`);
  opts.push(`Comment "TEMPLATE" and we'll send you the exact setup.`);
  opts.push(`Tag a teammate who's still ${lower(trimEnd(pain))}.`);
  opts.push(`Save this for your next planning session.`);
  return opts[0] && opts.length > 3 && r() < 0.6 ? opts[0] : pick(r, opts);
}

function hashtagsFor(c, channel, r) {
  const limit = CHANNELS[channel]?.hashtagLimit ?? 3;
  if (!limit) return [];
  const words = [
    c.P.replace(/[^a-z0-9]/gi, ''),
    ...c.features.map((f) => f.name.replace(/[^a-z0-9 ]/gi, '').split(' ').map(capitalize).join('')),
    ...String(c.audience).split(/\s+/).filter((w) => w.length > 4).map((w) => capitalize(w.replace(/[^a-z0-9]/gi, ''))),
    'Productivity',
    'BuildInPublic',
    'SaaS',
  ].filter((w) => w && w.length > 2 && w.length < 24);
  const uniq = [...new Set(words)];
  return [uniq[0], ...shuffle(r, uniq.slice(1))].slice(0, limit).map((w) => `#${w}`);
}

function titleFor(channel, format, angle, variation) {
  return `${variation ? 'Variation · ' : ''}${CHANNELS[channel]?.label || channel} ${FORMATS[format].label} — ${angle.name}`;
}

function videoContent(c, f, f2, pain, hook, cta, share, format) {
  const isReel = format === 'reel';
  const beats = isReel
    ? [
        { t: [0, 3], type: 'hook', vo: hook, onScreen: short(hook, 8), shot: 'Face-to-camera or bold kinetic text on brand colour', visual: 'Pattern interrupt: fast zoom on the problem' },
        { t: [3, 8], type: 'problem', vo: `Most ${c.audience} lose time ${lower(trimEnd(pain))}.`, onScreen: `${capitalize(trimEnd(pain))}?`, shot: 'Screen recording of the old way', visual: 'Messy tabs / spreadsheet chaos, slightly desaturated' },
        { t: [8, 14], type: 'demo', vo: `With ${c.P}, ${lower(trimEnd(f.benefit))}.`, onScreen: f.name, shot: 'Screen recording — cursor zoom on the feature', visual: `Real product UI showing ${f.name}` },
        { t: [14, 19], type: 'proof', vo: `And ${lower(trimEnd(f2.benefit))}.`, onScreen: `Before → After`, shot: 'Split-screen before/after', visual: `Old way left, ${c.P} result right` },
        { t: [19, 22], type: 'cta', vo: `${cta}. ${share}`, onScreen: cta, shot: 'End card with logo + CTA', visual: 'Logo, URL and offer badge' },
      ]
    : [
        { t: [0, 4], type: 'hook', vo: hook, onScreen: short(hook, 8), shot: 'Title card over product UI', visual: 'Brand gradient, headline animates in' },
        { t: [4, 12], type: 'problem', vo: `If you're ${lower(trimEnd(pain))}, you know how much time it eats.`, onScreen: capitalize(trimEnd(pain)), shot: 'Screen recording of the old workflow', visual: 'Old workflow with friction highlighted' },
        { t: [12, 24], type: 'demo', vo: `${c.P} fixes that: ${lower(trimEnd(f.benefit))}.`, onScreen: `Step 1 · ${f.name}`, shot: 'Product walkthrough, step 1', visual: `Click-through of ${f.name}` },
        { t: [24, 34], type: 'demo', vo: `Then ${lower(trimEnd(f2.benefit))}.`, onScreen: `Step 2 · ${f2.name}`, shot: 'Product walkthrough, step 2', visual: `Click-through of ${f2.name}` },
        { t: [34, 40], type: 'proof', vo: `Same task — before and after.`, onScreen: 'Before → After', shot: 'Side-by-side comparison', visual: 'Timer overlay comparing both workflows' },
        { t: [40, 45], type: 'cta', vo: `${cta}. ${share}`, onScreen: cta, shot: 'End card', visual: 'Logo, URL, offer' },
      ];
  const fmt = (s) => `0:${String(s).padStart(2, '0')}`;
  return {
    durationSec: beats.at(-1).t[1],
    script: {
      hook: { time: `${fmt(beats[0].t[0])}–${fmt(beats[0].t[1])}`, vo: beats[0].vo, onScreen: beats[0].onScreen },
      body: beats.slice(1, -1).map((b) => ({ time: `${fmt(b.t[0])}–${fmt(b.t[1])}`, vo: b.vo, onScreen: b.onScreen })),
      cta: { time: `${fmt(beats.at(-1).t[0])}–${fmt(beats.at(-1).t[1])}`, vo: beats.at(-1).vo, onScreen: beats.at(-1).onScreen },
    },
    storyboard: beats.map((b, i) => ({ scene: i + 1, start: b.t[0], end: b.t[1], type: b.type, shot: b.shot, visual: b.visual, onScreenText: b.onScreen, vo: b.vo })),
    voiceover: beats.map((b) => b.vo).join(' '),
    captions: beats.map((b) => ({ start: b.t[0], end: b.t[1], text: b.vo })),
    musicMood: { friendly: 'Upbeat lo-fi, 100 bpm', direct: 'Driving electronic, 120 bpm', formal: 'Minimal corporate piano', playful: 'Bouncy pop, 115 bpm' }[c.tone] || 'Upbeat lo-fi',
  };
}

/**
 * @returns {{title, headline, caption, cta, hashtags, content, angle}}
 */
export function mockAsset({ workspace, campaign, channel, format, version = 1, variationOf = null, seedExtra = '' }) {
  const c = ctx(workspace);
  const r = rng(`${workspace.id}|${campaign?.id}|${channel}|${format}|${version}|${variationOf?.id || ''}|${seedExtra}`);
  let angles = shuffle(r, ANGLES);
  if (variationOf?.content?.angle) angles = angles.filter((a) => a.key !== variationOf.content.angle).concat(angles.filter((a) => a.key === variationOf.content.angle));
  const angle = angles[0];
  const [f, f2] = shuffle(r, c.features).concat(c.features);
  const pain = pick(r, c.pains);
  const hook = angle.hook(c, f, pain);
  const cta = ctaFor(c, channel);
  const share = shareLine(c, r, pain);
  const hashtags = hashtagsFor(c, channel, r);
  const link = CHANNELS[channel]?.linkInCaption === false ? '' : '{{link}}';
  const ch = CHANNELS[channel] || { captionLimit: 2200 };
  const valueProps = shuffle(r, c.valueProps).slice(0, 3);
  let content = { angle: angle.key, angleName: angle.name, hook };
  let headline = hook;
  let caption;

  if (format === 'reel' || format === 'video') {
    Object.assign(content, videoContent(c, f, f2, pain, hook, cta, share, format));
    caption = [hook, '', `${c.P}: ${lower(trimEnd(f.benefit))}.`, share, '', `${cta} ${link}`.trim()].join('\n');
  } else if (format === 'flyer') {
    headline = wordCount(hook) <= 9 ? trimEnd(hook) : valueProps.find((v) => wordCount(v) <= 8) || `${f.name}, minus the busywork`;
    Object.assign(content, { subhead: c.tagline, valueProps, badge: c.offer || null, footer: c.domain });
    caption = [headline + '.', '', ...valueProps.map((v) => `✓ ${v}`), '', share, `${cta} ${link}`.trim()].join('\n');
  } else if (format === 'carousel') {
    const slides = [
      { title: hook, body: `Swipe → ${c.P} in ${Math.min(c.features.length, 3) + 2} slides` },
      { title: `The problem`, body: `${capitalize(trimEnd(pain))} costs ${c.audience} hours every week.` },
      ...c.features.slice(0, 3).map((ft, i) => ({ title: `Step ${i + 1}: ${ft.name}`, body: ft.benefit })),
      { title: 'Before → After', body: `${capitalize(trimEnd(pain))} → ${trimEnd(f.benefit)}.` },
      { title: cta, body: share },
    ];
    Object.assign(content, { slides });
    caption = [hook, '', `${slides.length} slides on how ${c.P} works. ${share}`, '', `${cta} ${link}`.trim()].join('\n');
  } else {
    // post
    if (channel === 'x' || channel === 'threads') {
      caption = `${hook}\n\n${c.P}: ${lower(trimEnd(f.benefit))}.\n\n${link}`.trim();
    } else if (channel === 'linkedin') {
      caption = [
        hook,
        '',
        `Most ${c.audience} we talk to lose hours ${lower(trimEnd(pain))}.`,
        '',
        `So we built ${c.P}:`,
        ...c.features.slice(0, 3).map((ft) => `→ ${ft.name}: ${lower(trimEnd(ft.benefit))}`),
        '',
        share,
        '',
        `${cta}: ${link}`,
      ].join('\n');
    } else if (channel === 'reddit') {
      caption = [
        `**${c.P} — ${trimEnd(c.tagline)}** (maker here, feedback welcome)`,
        '',
        `I kept ${lower(trimEnd(pain))}, so I built a tool for it. What it does:`,
        ...c.features.slice(0, 4).map((ft) => `- **${ft.name}** — ${ft.benefit}`),
        '',
        `Happy to answer anything. Link: ${link}`,
      ].join('\n');
    } else if (channel === 'product_hunt') {
      headline = trimEnd(c.tagline).slice(0, 60);
      caption = [
        `Tagline: ${headline}`,
        '',
        `First comment: Hey Hunters! We built ${c.P} because we were tired of ${lower(trimEnd(pain))}.`,
        ...c.features.slice(0, 3).map((ft) => `• ${ft.name} — ${ft.benefit}`),
        c.offer ? `\nLaunch offer: ${c.offer}` : '',
        `\nWe'd love your feedback! ${link}`,
      ].join('\n');
    } else {
      caption = [hook, '', `${c.P}: ${lower(trimEnd(f.benefit))}.`, share, '', `${cta} ${link}`.trim()].join('\n');
    }
    Object.assign(content, { imageHeadline: wordCount(hook) <= 10 ? trimEnd(hook) : f.name, imageSub: trimEnd(f.benefit) });
  }

  if (caption.length > ch.captionLimit) caption = caption.slice(0, ch.captionLimit - 1) + '…';
  if (variationOf) content.variationNote = `Follow-up variation of “${variationOf.title}” using the ${angle.name.toLowerCase()} angle.`;

  return {
    title: titleFor(channel, format, angle, !!variationOf),
    headline,
    caption,
    cta,
    hashtags,
    content,
  };
}

export function mockAnalyze({ url, text = '', extracted = {} }) {
  const title = extracted.ogSiteName || String(extracted.title || '').split(/\s[|–—-]\s/)[0] || '';
  let name = title.trim();
  if (!name && url) {
    try {
      name = capitalize(new URL(url).hostname.replace(/^www\./, '').split('.')[0]);
    } catch {}
  }
  const lines = String(text).split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (!name) name = lines[0]?.slice(0, 40) || 'My Product';
  const description = extracted.description || lines.find((l) => wordCount(l) > 8) || '';
  const candidates = [...(extracted.listItems || []), ...(extracted.headings || []).slice(1), ...lines.filter((l) => /^[-•*]/.test(l)).map((l) => l.replace(/^[-•*]\s*/, ''))]
    .map((s) => s.trim())
    .filter((s) => wordCount(s) >= 3 && wordCount(s) <= 16);
  const uniq = [...new Set(candidates)].slice(0, 6);
  const features = uniq.map((s) => {
    const [head, ...rest] = s.split(/\s[—–-]\s|:\s/);
    return rest.length ? { name: short(head, 5), benefit: rest.join(' ') } : { name: capitalize(short(s, 3)), benefit: s };
  });
  const lc = (text + ' ' + description).toLowerCase();
  const audience = /developer|engineer|api/.test(lc)
    ? 'developers'
    : /remote|distributed|async/.test(lc)
      ? 'remote teams'
      : /creator|youtube|podcast/.test(lc)
        ? 'creators'
        : /founder|startup/.test(lc)
          ? 'startup founders'
          : /marketer|marketing/.test(lc)
            ? 'marketers'
            : /team/.test(lc)
              ? 'small teams'
              : 'busy professionals';
  const pains = [...lc.matchAll(/(?:no more|stop|without|tired of|instead of)\s+([a-z ,']{6,50})/g)].map((m) => m[1].trim()).slice(0, 3);
  return {
    name,
    tagline: (extracted.headings?.[0] || description).slice(0, 90),
    description: description.slice(0, 400),
    features: features.length ? features : [{ name: 'Core workflow', benefit: description.slice(0, 80) || 'Saves time on repetitive work' }],
    value_props: (extracted.headings || []).slice(0, 3).filter(Boolean),
    pain_points: pains.length ? pains : ['juggling manual workarounds'],
    audience,
    pricing: extracted.prices?.[0] || '',
    hooks: [],
    referral_mechanics: /refer|invite/.test(lc) ? 'Referral / invite program mentioned on site' : '',
  };
}

export const MOCK_SLUG = slugify;
