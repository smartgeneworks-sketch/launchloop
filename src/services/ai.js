/**
 * AIService — provider abstraction over Gemini / OpenAI with a deterministic
 * mock fallback. Every public method returns the same normalised shape no
 * matter which provider ran, so the rest of the app never branches on provider.
 * Any provider error (network, quota, bad JSON) degrades to the mock output and
 * is recorded in `generator` (e.g. "mock (fallback: openai 429)").
 */
import { CHANNELS, FORMATS, TASK_CATEGORIES } from '../lib/channels.js';
import { mockAnalyze, mockAsset } from './mockGenerator.js';
import { defaultTasks } from './tasks.js';

const SYSTEM = `You are a senior growth marketer and copywriter for software launches.
Rules: only use facts provided about the product; never invent statistics, user counts, testimonials, awards or prices.
Write short, concrete, platform-native copy. Hooks must land in under 3 seconds (≤12 words), show the workflow rather than describe it, and include a share mechanic (template, before/after, referral/invite prompt, or community reply prompt).
Use the token {{link}} wherever the tracked URL should go in the caption only (never write a raw URL). Never put {{link}} or any URL in on-screen text, voiceover, storyboard, script, slides or image headlines — on video, say "link in bio" or show the domain instead. Always respond with a single JSON object and nothing else.`;

export class AIService {
  constructor(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    const pref = (env.AI_PROVIDER || 'auto').toLowerCase();
    if (pref === 'mock') this.provider = 'mock';
    else if (pref === 'gemini' && env.GEMINI_API_KEY) this.provider = 'gemini';
    else if (pref === 'openai' && env.OPENAI_API_KEY) this.provider = 'openai';
    else if (pref === 'auto') this.provider = env.GEMINI_API_KEY ? 'gemini' : env.OPENAI_API_KEY ? 'openai' : 'mock';
    else this.provider = 'mock';
    this.models = {
      gemini: env.GEMINI_MODEL || 'gemini-2.5-flash',
      openai: env.OPENAI_MODEL || 'gpt-4o-mini',
      openaiImage: env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
    };
    this.imageGeneration = env.AI_IMAGE_GENERATION === 'true' && this.provider === 'openai';
  }

  info() {
    return { provider: this.provider, model: this.provider === 'mock' ? null : this.models[this.provider], imageGeneration: this.imageGeneration, lastError: this.lastError || null, lastSuccessAt: this.lastSuccessAt || null };
  }

  // ------------------------------------------------------------- transport
  async json(prompt) {
    if (this.provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.models.gemini)}:generateContent`;
      const res = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.8 },
        }),
      });
      if (!res.ok) throw new Error(`gemini ${res.status}`);
      const data = await res.json();
      return parseJson(data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '');
    }
    if (this.provider === 'openai') {
      const res = await this.fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: this.models.openai,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}`);
      const data = await res.json();
      return parseJson(data.choices?.[0]?.message?.content || '');
    }
    throw new Error('mock');
  }

  async withFallback(fn, fallback) {
    if (this.provider === 'mock') return { ...fallback(), generator: 'mock' };
    try {
      const out = await fn();
      this.lastSuccessAt = new Date().toISOString();
      this.lastError = null;
      return { ...out, generator: `${this.provider}:${this.models[this.provider]}` };
    } catch (e) {
      console.warn(`[ai] ${this.provider} failed (${e.message}); using mock output`);
      this.lastError = { at: new Date().toISOString(), message: e.message, hint: aiErrorHint(e.message, this.provider) };
      return { ...fallback(), generator: `mock (fallback: ${e.message})` };
    }
  }

  // ------------------------------------------------------------- 1. analysis
  async analyzeProduct({ url, text, extracted = {} }) {
    const mock = () => mockAnalyze({ url, text: text || extracted.text, extracted });
    return this.withFallback(async () => {
      const out = await this.json(`Extract structured product marketing facts from this source.
Return JSON: {"name":string,"tagline":string(≤90 chars),"description":string,"features":[{"name":string(≤5 words),"benefit":string(one sentence, outcome-focused)}] (3-6),"value_props":[string](3),"pain_points":[string](2-4, phrased as activities e.g. "chasing status updates in Slack"),"audience":string,"pricing":string|"" ,"hooks":[string](3, ≤12 words),"referral_mechanics":string|""}
Source URL: ${url || '(manual paste)'}
Title: ${extracted.title || ''}
Meta description: ${extracted.description || ''}
Headings: ${(extracted.headings || []).join(' | ')}
List items: ${(extracted.listItems || []).slice(0, 30).join(' | ')}
Prices seen: ${(extracted.prices || []).join(', ')}
Body text:
${String(text || extracted.text || '').slice(0, 7000)}`);
      const m = mock();
      return {
        ...m,
        ...pickDefined(out, ['name', 'tagline', 'description', 'audience', 'pricing', 'referral_mechanics']),
        features: Array.isArray(out.features) && out.features.length ? out.features.filter((f) => f?.name).slice(0, 6) : m.features,
        value_props: arr(out.value_props, m.value_props),
        pain_points: arr(out.pain_points, m.pain_points),
        hooks: arr(out.hooks, m.hooks),
      };
    }, mock);
  }

  // ------------------------------------------------------------- 2. copy, scripts, tasks
  async generateAsset({ workspace, campaign, channel, format, version = 1, variationOf = null, metrics = null, instruction = '', seed = '' }) {
    const mock = () => mockAsset({ workspace, campaign, channel, format, version, variationOf, seedExtra: `${instruction}|${seed}` });
    return this.withFallback(async () => {
      const ch = CHANNELS[channel];
      const shape = {
        reel: '"content":{"hook":string,"angleName":string,"durationSec":number(15-30),"script":{"hook":{"time":"0:00–0:03","vo":string,"onScreen":string},"body":[{"time":string,"vo":string,"onScreen":string}],"cta":{"time":string,"vo":string,"onScreen":string}},"storyboard":[{"scene":number,"start":number,"end":number,"type":"hook|problem|demo|proof|cta","shot":string,"visual":string,"onScreenText":string,"vo":string}],"voiceover":string,"captions":[{"start":number,"end":number,"text":string}],"musicMood":string}',
        video: '"content": same structure as a reel but 30-60s, 16:9 product walkthrough with numbered steps',
        flyer: '"content":{"hook":string,"angleName":string,"subhead":string,"valueProps":[string,string,string],"badge":string|null,"footer":string}',
        post: '"content":{"hook":string,"angleName":string,"imageHeadline":string(≤8 words),"imageSub":string}',
        carousel: '"content":{"hook":string,"angleName":string,"slides":[{"title":string,"body":string}] (5-7; slide 1 = hook, last = CTA + share prompt, middle = numbered steps / before→after)}',
      }[format];
      const out = await this.json(`Create one ${FORMATS[format].label} for ${ch.label} (aspect ${ch.formats[format]}, caption limit ${ch.captionLimit} chars, max ${ch.hashtagLimit} hashtags${ch.linkInCaption ? '' : ', links are not clickable in captions so say "link in bio"'}).
Return JSON: {"title":string,"headline":string,"caption":string,"cta":string,"hashtags":[string], ${shape}}
Product: ${workspace.name} — ${workspace.tagline || ''}
Description: ${workspace.description || ''}
Features: ${JSON.stringify(workspace.features || [])}
Value props: ${JSON.stringify(workspace.value_props || [])}
Pain points: ${JSON.stringify(workspace.pain_points || [])}
Audience: ${workspace.audience || ''}
Offer: ${workspace.offer || 'none'}; Pricing: ${workspace.pricing || 'n/a'}
Referral / share mechanics: ${workspace.referral_mechanics || 'none defined'}
Locale: ${JSON.stringify(workspace.locale || {})}
Audience location: ${regionName(workspace.locale?.region)} — write for people there: local spelling and phrasing, prices in ${workspace.locale?.currency || 'the local currency'}, culturally relevant everyday examples, and the language "${workspace.locale?.language || 'en'}". Don't use stereotypes or forced slang.
Campaign: ${campaign.name}; goal: ${campaign.goal || 'signups'}
${variationOf ? `This is a FOLLOW-UP VARIATION of a top performer. Keep what worked, change the hook angle. Original: ${JSON.stringify({ headline: variationOf.headline, hook: variationOf.content?.hook, caption: variationOf.caption })}. Metrics: ${JSON.stringify(metrics || {})}` : ''}
${instruction ? `Extra instruction from the user: ${instruction}` : ''}`);
      return normalizeAsset(out, mock(), format, channel);
    }, mock);
  }

  async generateTasks({ workspace, campaign }) {
    const base = () => ({ tasks: defaultTasks({ workspace, campaign }) });
    return this.withFallback(async () => {
      const out = await this.json(`Tailor this launch checklist for the product below. Keep every task's category, role and dayOffset; you may rewrite titles/descriptions to be specific to the product and add up to 3 extra tasks.
Allowed categories: ${TASK_CATEGORIES.join(', ')}.
Return JSON: {"tasks":[{"title":string,"description":string,"category":string,"role":string,"dayOffset":number}]}
Product: ${workspace.name} — ${workspace.tagline}; audience: ${workspace.audience}; channels: ${campaign.channels.join(', ')}
Checklist: ${JSON.stringify(base().tasks.map(({ title, category, role, dayOffset }) => ({ title, category, role, dayOffset })))}`);
      const tasks = (out.tasks || []).filter((t) => t.title && TASK_CATEGORIES.includes(t.category) && Number.isFinite(t.dayOffset));
      if (tasks.length < 8) throw new Error('task list too short');
      return { tasks };
    }, base);
  }

  // ------------------------------------------------------------- 3. images
  /** Optional AI background art for flyers. Returns a data URL or null (brand SVG is always rendered regardless). */
  async generateImage({ workspace, asset }) {
    if (!this.imageGeneration) return null;
    try {
      const res = await this.fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: this.models.openaiImage,
          size: asset.aspect_ratio === '9:16' ? '1024x1536' : asset.aspect_ratio === '1:1' ? '1024x1024' : '1536x1024',
          prompt: `Abstract, text-free background art for a software promo flyer. Brand colours ${JSON.stringify(workspace.brand?.colors || {})}. Theme: ${asset.headline}. Leave large calm areas for headline text. No words, no logos.`,
        }),
      });
      if (!res.ok) throw new Error(`openai image ${res.status}`);
      const data = await res.json();
      const b64 = data.data?.[0]?.b64_json;
      return b64 ? `data:image/png;base64,${b64}` : null;
    } catch (e) {
      console.warn(`[ai] image generation failed (${e.message}); using brand SVG only`);
      return null;
    }
  }
}

// ------------------------------------------------------------- helpers
function regionName(code) {
  try {
    return (code && new Intl.DisplayNames(['en'], { type: 'region' }).of(code)) || 'not specified';
  } catch {
    return code || 'not specified';
  }
}
export function aiErrorHint(msg, provider) {
  const key = provider === 'gemini' ? 'GEMINI' : 'OPENAI';
  if (/\b404\b/.test(msg)) return `Model not found — set ${key}_MODEL to a model your key can use.`;
  if (/\b429\b/.test(msg)) return 'Quota or rate limit reached — wait, or enable billing on the provider account.';
  if (/\b(400|401|403)\b/.test(msg)) return `The API key was rejected — check ${key}_API_KEY.`;
  return 'Temporary error — try Regenerate.';
}
const LINK_RE = /\s*\{\{\s*link\s*\}\}\s*/gi;
const noLink = (v) => (typeof v === 'string' ? v.replace(LINK_RE, ' ').replace(/\s{2,}/g, ' ').trim() : v);
/** {{link}} belongs in captions only — strip it from anything rendered on screen or spoken. */
export function stripLinkTokens(content) {
  const c = { ...content };
  for (const k of ['hook', 'imageHeadline', 'imageSub', 'subhead', 'badge', 'voiceover']) c[k] = noLink(c[k]);
  if (Array.isArray(c.storyboard)) c.storyboard = c.storyboard.map((s) => ({ ...s, onScreenText: noLink(s.onScreenText), vo: noLink(s.vo) }));
  if (Array.isArray(c.captions)) c.captions = c.captions.map((s) => ({ ...s, text: noLink(s.text) }));
  if (Array.isArray(c.slides)) c.slides = c.slides.map((s) => ({ ...s, title: noLink(s.title), body: noLink(s.body) }));
  if (Array.isArray(c.valueProps)) c.valueProps = c.valueProps.map(noLink);
  if (c.script) {
    const fix = (b) => b && { ...b, vo: noLink(b.vo), onScreen: noLink(b.onScreen) };
    c.script = { hook: fix(c.script.hook), body: (c.script.body || []).map(fix), cta: fix(c.script.cta) };
  }
  return c;
}
function parseJson(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('invalid JSON from model');
  }
}
const arr = (v, d) => (Array.isArray(v) && v.length ? v.filter((x) => typeof x === 'string') : d);
function pickDefined(o, keys) {
  const r = {};
  for (const k of keys) if (typeof o?.[k] === 'string' && o[k].trim()) r[k] = o[k].trim();
  return r;
}

/** Merge model output over the mock skeleton so the shape is always complete. */
export function normalizeAsset(out, mock, format, channel) {
  const ch = CHANNELS[channel];
  const content = { ...mock.content, ...(out.content && typeof out.content === 'object' ? out.content : {}) };
  if ((format === 'reel' || format === 'video') && !(Array.isArray(content.storyboard) && content.storyboard.length)) content.storyboard = mock.content.storyboard;
  if (format === 'carousel' && !(Array.isArray(content.slides) && content.slides.length)) content.slides = mock.content.slides;
  if (format === 'flyer' && !(Array.isArray(content.valueProps) && content.valueProps.length)) content.valueProps = mock.content.valueProps;
  let caption = typeof out.caption === 'string' && out.caption.trim() ? out.caption.trim() : mock.caption;
  if (caption.length > ch.captionLimit) caption = caption.slice(0, ch.captionLimit - 1) + '…';
  const hashtags = (Array.isArray(out.hashtags) ? out.hashtags : mock.hashtags)
    .map((h) => '#' + String(h).replace(/^#/, '').replace(/\s+/g, ''))
    .slice(0, ch.hashtagLimit);
  return {
    title: out.title || mock.title,
    headline: noLink(out.headline || mock.headline),
    caption,
    cta: out.cta || mock.cta,
    hashtags,
    content: stripLinkTokens(content),
  };
}
