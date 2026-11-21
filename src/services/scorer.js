/**
 * Hook & Virality Advisor — transparent heuristic scoring (works offline).
 * Every point awarded or withheld produces a reason, and every weak dimension
 * produces a concrete, product-specific suggestion.
 */
import { clamp, wordCount } from '../lib/util.js';

const PAIN_WORDS = /\b(stop|still|tired|hate|waste|wasting|losing|lose|no more|without|chaos|manual|messy|hours|struggle)\b/i;
const DIRECT_WORDS = /\b(you|your|pov|here'?s|watch|before|after)\b|\?/i;
const SHOW_WORDS = /\b(watch|see|demo|step|before|after|→|screen|walkthrough|in \d+ seconds|in \d+ steps|how)\b/i;
const SHARE_WORDS = /\b(tag|share|save|template|invite|refer|referral|comment|duplicate|remix|send (it|this) to)\b/i;

function textOf(asset) {
  const c = asset.content || {};
  const parts = [asset.headline, asset.caption, asset.cta, c.hook, c.voiceover, ...(c.slides || []).map((s) => `${s.title} ${s.body}`), ...(c.storyboard || []).map((s) => `${s.shot} ${s.visual}`)];
  return parts.filter(Boolean).join('\n');
}

export function scoreAsset(asset, workspace = {}) {
  const c = asset.content || {};
  const hook = String(c.hook || asset.headline || asset.caption?.split('\n')[0] || '').trim();
  const all = textOf(asset);
  const reasons = [];
  const suggestions = [];
  const P = workspace.name || 'your product';

  // 1. Hook clarity
  let hookScore = 20;
  const wc = wordCount(hook);
  if (wc && wc <= 12) (hookScore += 30), reasons.push(`Hook is ${wc} words — readable in under 3 seconds.`);
  else if (wc) (hookScore += 10), suggestions.push(`Cut the hook to ≤12 words (currently ${wc}). Lead with the outcome, not the setup.`);
  if (DIRECT_WORDS.test(hook)) (hookScore += 20), reasons.push('Hook speaks directly to the viewer.');
  else suggestions.push('Address the viewer directly ("you", a question, or "POV:") in the first line.');
  if (PAIN_WORDS.test(hook)) (hookScore += 20), reasons.push('Hook names a pain the audience recognises.');
  else suggestions.push(`Name the pain first — e.g. “Still ${(workspace.pain_points?.[0] || 'doing this by hand').toLowerCase()}?”`);
  if (/\d/.test(hook) || (workspace.features || []).some((f) => hook.toLowerCase().includes(String(f.name || '').toLowerCase()))) (hookScore += 10), reasons.push('Hook is specific (number or named feature).');
  if (new RegExp(`^(introducing|meet|announcing)\\b`, 'i').test(hook)) (hookScore -= 25), suggestions.push('Avoid “Introducing…” openers — they tell instead of show and get skipped.');

  // 2. Show-don't-tell workflow proof
  let showScore = 20;
  const sb = c.storyboard || [];
  const proofScenes = sb.filter((s) => /screen|demo|walkthrough|before|after|split/i.test(`${s.shot} ${s.visual}`)).length;
  if (sb.length) {
    showScore += Math.min(proofScenes * 18, 54);
    if (proofScenes >= 2) reasons.push(`${proofScenes} scenes show the real product or a before/after.`);
    else suggestions.push('Add a screen-recording scene of the actual workflow and a before/after split — proof beats claims.');
  } else if (c.slides?.length) {
    const stepSlides = c.slides.filter((s) => /step|before|after|→/i.test(s.title + s.body)).length;
    showScore += Math.min(stepSlides * 15, 60);
    if (stepSlides >= 2) reasons.push('Carousel walks through concrete steps.');
    else suggestions.push('Turn slides into numbered steps with a screenshot each.');
  } else if (SHOW_WORDS.test(all)) (showScore += 40), reasons.push('Copy points at a demo or concrete steps.');
  else suggestions.push(`Show the result: pair this with a 5-second screen capture of ${P} or a before/after image.`);
  if ((workspace.screenshots || []).length && (asset.format === 'flyer' || asset.format === 'post')) (showScore += 15), reasons.push('Uses a real product screenshot.');
  if (/→|before/i.test(all)) showScore += 10;

  // 3. Shareability
  let shareScore = 15;
  if (SHARE_WORDS.test(all)) (shareScore += 40), reasons.push('Includes an explicit share / save / comment mechanic.');
  else suggestions.push('Add a share mechanic: “Comment TEMPLATE and we’ll DM you the setup” or “Tag a teammate who needs this.”');
  if (workspace.referral_mechanics) {
    if (/invite|refer/i.test(all)) (shareScore += 25), reasons.push('Connects to your referral / invite loop.');
    else suggestions.push(`Close the loop with your referral mechanic: ${workspace.referral_mechanics}.`);
  } else suggestions.push('Define a referral or invite incentive in the workspace so creatives can point to it.');
  if (/template|before|after/i.test(all)) (shareScore += 15), reasons.push('Before/after or template formats are naturally re-shared.');

  // 4. CTA
  let ctaScore = 0;
  if (asset.cta) (ctaScore += 60), reasons.push('Clear call-to-action.');
  else suggestions.push('Add a single, explicit CTA.');
  if (/\{\{link\}\}|https?:\/\//.test(asset.caption || '') || /link in bio/i.test(asset.cta || '')) ctaScore += 40;
  else suggestions.push('Include the tracked link ({{link}}) so clicks are attributed to this creative.');

  const dims = { hook: clamp(hookScore, 0, 100), showDontTell: clamp(showScore, 0, 100), shareability: clamp(shareScore, 0, 100), cta: clamp(ctaScore, 0, 100) };
  const overall = Math.round(dims.hook * 0.35 + dims.showDontTell * 0.25 + dims.shareability * 0.25 + dims.cta * 0.15);
  const tags = [];
  if (dims.hook >= 75) tags.push('strong-hook');
  else tags.push('weak-hook');
  if (dims.showDontTell >= 60) tags.push('shows-workflow');
  else tags.push('needs-proof');
  if (dims.shareability >= 60) tags.push('shareable');
  if (overall >= 75) tags.push('ready');

  const mechanics = [
    { key: 'template', label: 'Shareable template', idea: `Offer the exact ${P} setup as a duplicable template — "comment TEMPLATE".` },
    { key: 'beforeafter', label: 'Before/after demo', idea: 'Split-screen the old workflow vs. the new one with a timer overlay.' },
    { key: 'referral', label: 'Referral prompt', idea: workspace.referral_mechanics ? `End with: ${workspace.referral_mechanics}.` : 'Add a give-get invite reward (e.g. both sides get a free month).' },
    { key: 'community', label: 'Community replies', idea: 'Pin a question ("What would you automate first?") and reply to every comment in the first 2 hours.' },
  ];

  return { overall, dims, tags, reasons, suggestions: [...new Set(suggestions)].slice(0, 5), mechanics, scoredAt: new Date().toISOString() };
}
