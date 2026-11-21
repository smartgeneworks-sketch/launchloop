/**
 * Demo seed: a software launch ("Relay 2.0") with creatives in every state,
 * live scheduled jobs (one auto-publishes ~1 min after start, one needs the
 * Share Kit), published posts with simulated metrics, attributed conversions
 * and a half-done launch checklist. Run `npm run seed` to reset.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { loadEnv } from './lib/env.js';
import { addDays, addMinutes, id, isoDate, nowIso } from './lib/util.js';
import { AIService } from './services/ai.js';
import { createCampaign, createWorkspace, generatePackage, handleConversion } from './services/core.js';
import { transition } from './services/stateMachine.js';
import { utmContentFor } from './services/utm.js';
import { seedSimulatedMetrics } from './worker.js';

const svgData = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

const LOGO = svgData(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80"><circle cx="40" cy="40" r="30" fill="#F4A259"/><path d="M26 40h28M42 28l12 12-12 12" stroke="#0F3D3E" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/><text x="84" y="54" font-family="Inter,Arial,sans-serif" font-size="44" font-weight="800" fill="#FFFFFF">relay</text></svg>`);

const SCREENSHOT = svgData(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 760">
<rect width="1200" height="760" fill="#F7F5F0"/><rect width="240" height="760" fill="#0F3D3E"/>
<circle cx="48" cy="48" r="16" fill="#F4A259"/><rect x="76" y="40" width="110" height="16" rx="8" fill="#ffffff" opacity=".9"/>
${[0, 1, 2, 3, 4].map((i) => `<rect x="32" y="${120 + i * 48}" width="${150 - i * 12}" height="14" rx="7" fill="#ffffff" opacity="${i === 0 ? 0.9 : 0.35}"/>`).join('')}
<text x="290" y="80" font-family="Inter,Arial" font-size="34" font-weight="800" fill="#0F3D3E">Today's standup · Design team</text>
<text x="290" y="114" font-family="Inter,Arial" font-size="18" fill="#5b6b6b">6 of 7 updates in · summary generated 9:02</text>
${['Maya', 'Jon', 'Priya', 'Leo'].map((n, i) => `<g transform="translate(290,${150 + i * 140})"><rect width="860" height="120" rx="16" fill="#fff" stroke="#e6e1d6"/><circle cx="50" cy="60" r="28" fill="${['#F4A259', '#7FB7BE', '#BC4B51', '#8CB369'][i]}"/><text x="96" y="48" font-family="Inter,Arial" font-size="22" font-weight="700" fill="#1b2b2b">${n}</text><rect x="96" y="64" width="${520 - i * 40}" height="12" rx="6" fill="#d9d4c7"/><rect x="96" y="86" width="${360 + i * 30}" height="12" rx="6" fill="#e9e5db"/><rect x="740" y="44" width="96" height="32" rx="16" fill="${i === 2 ? '#FDE8D0' : '#DDEFE6'}"/><text x="788" y="66" text-anchor="middle" font-family="Inter,Arial" font-size="15" font-weight="700" fill="${i === 2 ? '#B5651D' : '#2F6B4F'}">${i === 2 ? 'Blocked' : 'On track'}</text></g>`).join('')}
</svg>`);

export async function seed(ctx) {
  const { db } = ctx;
  const mockCtx = { ...ctx, ai: new AIService({ AI_PROVIDER: 'mock' }) }; // seed is always deterministic & offline
  const ws = createWorkspace(mockCtx, {
    name: 'Relay',
    website_url: 'https://relay.example.com',
    tagline: 'Async standups that write themselves',
    description: 'Relay collects short async check-ins from your team in Slack and turns them into a daily summary, blocker alerts and a searchable progress log — so you can drop the daily status meeting.',
    features: [
      { name: 'Auto standup summaries', benefit: 'Turns everyone’s check-ins into one 30-second daily digest' },
      { name: 'Blocker radar', benefit: 'Flags blocked work the moment someone mentions it' },
      { name: 'Slack-native check-ins', benefit: 'Teammates answer three prompts without leaving Slack' },
      { name: 'Progress timeline', benefit: 'Every update becomes a searchable log for retros and reviews' },
    ],
    value_props: ['Cancel the daily status meeting', 'See blockers before they cost a sprint', 'Works where your team already talks'],
    pain_points: ['sitting through 30-minute status meetings', 'chasing updates in Slack threads', 'finding out about blockers at the retro'],
    audience: 'remote product and engineering teams',
    pricing: '$6 per user / month',
    offer: '50% off for 3 months at launch',
    referral_mechanics: 'invite a teammate and you both get a month of Pro free',
    brand: { colors: { primary: '#0F3D3E', secondary: '#1B5E5F', accent: '#F4A259' }, fonts: { heading: 'Inter', body: 'Inter' }, logo: LOGO },
    locale: { language: 'en', region: 'US', currency: 'USD', dateFormat: 'MMM D, YYYY', tone: 'friendly' },
    screenshots: [{ name: 'standup-dashboard.svg', dataUrl: SCREENSHOT }],
  });
  db.update('workspaces', ws.id, { source_meta: { url: ws.website_url, manual: false, pages: [{ url: ws.website_url, title: 'Relay — Async standups that write themselves' }], notes: ['Seeded demo data'], generator: 'mock', importedAt: nowIso() } });

  const channels = ['instagram', 'tiktok', 'linkedin', 'x', 'youtube_shorts', 'reddit', 'product_hunt'];
  const campaign = await createCampaign(mockCtx, ws.id, { name: 'Relay 2.0 Launch', goal: 'Drive 500 trial signups in launch week', launch_date: isoDate(addDays(new Date(), 4)), channels, base_url: 'https://relay.example.com/2' });
  await generatePackage(mockCtx, campaign.id, {});

  const assets = db.all('creative_assets', 'SELECT * FROM creative_assets WHERE campaign_id = ?', campaign.id);
  const find = (ch, fmt) => assets.find((a) => a.channel === ch && a.format === fmt);
  const walk = (asset, steps, extra = {}) => {
    let a = asset;
    for (const [to, actor, note, patch] of steps) a = transition(db, a, to, { actor, note, patch: { ...(patch || {}) } });
    return Object.keys(extra).length ? db.update('creative_assets', a.id, extra) : a;
  };
  const toApproved = [
    ['NEEDS_REVIEW', 'user', 'Submitted'],
    ['APPROVED', 'user', 'Looks great'],
  ];
  const job = (asset, runAt, status, log) =>
    db.insert('schedule_jobs', { id: id('job'), asset_id: asset.id, channel: asset.channel, run_at: runAt.toISOString(), status, attempts: status === 'done' ? 1 : 0, log, created_at: nowIso(), updated_at: runAt.toISOString() });

  // Published (with history + simulated metrics)
  for (const [ch, fmt, daysAgo] of [
    ['instagram', 'reel', 3],
    ['linkedin', 'post', 2],
    ['x', 'post', 1],
  ]) {
    const a = find(ch, fmt);
    if (!a) continue;
    const when = addDays(new Date(), -daysAgo);
    const p = walk(a, [...toApproved, ['SCHEDULED', 'user', 'Teaser'], ['PUBLISHED', 'worker', 'Published (simulated)']], { published_at: when.toISOString(), scheduled_at: when.toISOString(), external_url: `https://example.com/mock/${ch}/seed` });
    job(p, when, 'done', [
      { at: when.toISOString(), level: 'info', msg: `Publishing to ${ch} (attempt 1, mock mode)` },
      { at: when.toISOString(), level: 'success', msg: `Published to ${ch} → https://example.com/mock/${ch}/seed` },
    ]);
    seedSimulatedMetrics(db, p, daysAgo + 1, when);
  }
  // Scheduled: one auto-publishes in ~1 min, one is Share-Kit (TikTok), one later
  const sched = [
    ['instagram', 'post', addMinutes(new Date(), 1)],
    ['tiktok', 'reel', addMinutes(new Date(), 2)],
    ['linkedin', 'carousel', addDays(new Date(), 2)],
  ];
  for (const [ch, fmt, when] of sched) {
    const a = find(ch, fmt);
    if (!a) continue;
    const s = walk(a, [...toApproved, ['SCHEDULED', 'user', `For ${when.toISOString()}`]], { scheduled_at: when.toISOString() });
    job(s, when, 'pending', [{ at: nowIso(), level: 'info', msg: `Queued for ${when.toISOString()}` }]);
  }
  const yt = find('youtube_shorts', 'reel');
  if (yt) walk(yt, toApproved);
  const xf = find('x', 'flyer');
  if (xf) walk(xf, toApproved);
  for (const [ch, fmt] of [
    ['instagram', 'carousel'],
    ['linkedin', 'video'],
    ['product_hunt', 'post'],
  ]) {
    const a = find(ch, fmt);
    if (a) walk(a, [['NEEDS_REVIEW', 'user', 'Submitted']]);
  }
  const igf = find('instagram', 'flyer');
  if (igf) walk(igf, [['NEEDS_REVIEW', 'user', 'Submitted'], ['NEEDS_REVISION', 'user', 'Headline is too long for a flyer — lead with “Cancel your standup meeting”.']]);
  const xv = find('x', 'video');
  if (xv) {
    const when = addDays(new Date(), -1);
    const f = walk(xv, [...toApproved, ['SCHEDULED', 'user', 'Teaser'], ['FAILED', 'worker', 'X API 403: media upload requires elevated access (mock)']], { error: 'X API 403: media upload requires elevated access (mock)', scheduled_at: when.toISOString() });
    job(f, when, 'failed', [
      { at: when.toISOString(), level: 'warn', msg: 'Attempt 1 failed: X API 403 (mock). Retrying' },
      { at: when.toISOString(), level: 'error', msg: 'Failed after 3 attempts: X API 403: media upload requires elevated access (mock). Asset marked FAILED.' },
    ]);
    db.insert('campaign_tasks', { id: id('tsk'), campaign_id: campaign.id, title: `Fix failed post: ${f.title}`, description: f.error, category: 'Publishing', role: 'Marketer', due_date: isoDate(new Date()), source: 'scheduler', asset_id: f.id, sort: 0 });
  }

  // Checklist progress: setup done, part of creative review done
  const tasks = db.all('campaign_tasks', 'SELECT * FROM campaign_tasks WHERE campaign_id = ? ORDER BY due_date, sort', campaign.id);
  for (const t of tasks) if (t.category === 'Setup' || (t.category === 'Creative Review' && /scripts|flyers/i.test(t.title)) || /teaser/i.test(t.title)) db.update('campaign_tasks', t.id, { done: true, done_at: nowIso() });

  // A few attributed conversions arriving through the webhook path
  const pub = db.all('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ? AND state = 'PUBLISHED'`, campaign.id);
  pub.forEach((a, i) => {
    for (let k = 0; k < 3 - i; k++) handleConversion(mockCtx, ws, { event: 'signup', utm_source: a.channel, utm_campaign: campaign.utm_campaign, utm_content: utmContentFor(a) });
  });
  return { workspace: ws, campaign };
}

// CLI: node src/seed.js --reset
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cfg = loadEnv();
  const file = path.join(cfg.dataDir, 'launchloop.db');
  if (process.argv.includes('--reset')) for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
  const db = openDb(file);
  const { campaign } = await seed({ db, config: cfg, ai: null });
  console.log(`Seeded demo campaign "${campaign.name}" into ${file}`);
}
