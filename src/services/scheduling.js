/**
 * Bulk scheduling: spread approved creatives across a date range at suggested
 * times per channel, in the audience's time zone. dryRun returns the plan only.
 */
import { CHANNELS } from '../lib/channels.js';
import { HttpError } from '../lib/util.js';
import { scheduleAsset, transitionAsset } from './core.js';

/** Suggested posting times (local to the audience). Starting points, not guarantees — editable per run. */
export const SUGGESTED_TIMES = {
  instagram: '19:00',
  tiktok: '19:30',
  youtube_shorts: '18:00',
  facebook: '13:00',
  linkedin: '08:30',
  x: '12:00',
  threads: '12:30',
  reddit: '09:00',
  product_hunt: '08:05', // Product Hunt's day starts 00:01 Pacific; adjust for your time zone
};
export const WEEKDAY_ONLY = ['linkedin'];

function tzOffsetMs(utcMs, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs;
}
/** "2026-11-24" + "19:00" in Africa/Accra → UTC ISO string. */
export function zonedToUtc(date, time, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let utc = guess - tzOffsetMs(guess, timeZone);
  utc = guess - tzOffsetMs(utc, timeZone); // second pass handles DST edges
  return new Date(utc).toISOString();
}
export function localDate(iso, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}
const addDay = (date, n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date) => new Date(date + 'T12:00:00Z').getUTCDay(); // 0 Sun … 6 Sat

export function planSchedule(db, campaignId, { assetIds, startDate, endDate, timezone = 'UTC', times = {}, perChannelPerDay = 1, maxPerDay = 2, weekdayOnly = WEEKDAY_ONLY, now = new Date() } = {}) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new HttpError(400, 'Unknown time zone');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) throw new HttpError(400, 'Pick a start and end date');
  if (endDate < startDate) throw new HttpError(400, 'End date is before start date');
  const all = db.all('creative_assets', `SELECT * FROM creative_assets WHERE campaign_id = ?`, campaignId);
  const chosen = all.filter((a) => a.state === 'APPROVED' && (!assetIds?.length || assetIds.includes(a.id)));
  if (!chosen.length) throw new HttpError(400, 'No approved creatives selected');
  // Existing posts per channel per local day count toward the daily cap.
  const busy = {};
  const dayTotal = {};
  for (const a of all) {
    const at = a.state === 'SCHEDULED' ? a.scheduled_at : a.state === 'PUBLISHED' ? a.published_at : null;
    if (!at) continue;
    const d = localDate(at, timezone);
    busy[`${a.channel}|${d}`] = (busy[`${a.channel}|${d}`] || 0) + 1;
    dayTotal[d] = (dayTotal[d] || 0) + 1;
  }
  const dayCap = Math.max(1, Math.min(12, Number(maxPerDay) || 2));
  // Queue per channel, best-scoring first so the strongest creative goes out first.
  const queues = {};
  for (const a of [...chosen].sort((x, y) => (y.score?.overall || 0) - (x.score?.overall || 0))) (queues[a.channel] ||= []).push(a);
  const plan = [];
  const cap = Math.max(1, Math.min(4, Number(perChannelPerDay) || 1));
  let rot = 0;
  for (let day = startDate; day <= endDate && Object.values(queues).some((q) => q.length); day = addDay(day, 1)) {
    const entries = Object.entries(queues);
    const ordered = entries.slice(rot % entries.length).concat(entries.slice(0, rot % entries.length)); // rotate so every channel gets early days
    rot++;
    for (const [channel, q] of ordered) {
      if (!q.length || (dayTotal[day] || 0) >= dayCap) continue;
      if (weekdayOnly.includes(channel) && [0, 6].includes(weekday(day))) continue;
      const base = /^\d{2}:\d{2}$/.test(times[channel] || '') ? times[channel] : SUGGESTED_TIMES[channel] || '12:00';
      const k = `${channel}|${day}`;
      while (q.length && (busy[k] || 0) < cap && (dayTotal[day] || 0) < dayCap) {
        const n = busy[k] || 0;
        const [h, m] = base.split(':').map(Number);
        const t = `${String(Math.min(23, h + n * 3)).padStart(2, '0')}:${String(m).padStart(2, '0')}`; // 2nd post same day: 3h later
        const runAt = zonedToUtc(day, t, timezone);
        busy[k] = n + 1;
        if (new Date(runAt) <= now) continue; // slot already passed today
        const a = q.shift();
        dayTotal[day] = (dayTotal[day] || 0) + 1;
        plan.push({ assetId: a.id, title: a.title, channel, channelLabel: CHANNELS[channel]?.label || channel, format: a.format, localDate: day, localTime: t, runAt, autoPublish: a.auto_publish });
      }
    }
  }
  const unscheduled = Object.values(queues).flat().map((a) => ({ assetId: a.id, title: a.title, channel: a.channel }));
  return { timezone, plan: plan.sort((a, b) => a.runAt.localeCompare(b.runAt)), unscheduled };
}

export function applySchedule(ctx, campaignId, opts) {
  const { plan, unscheduled, timezone } = planSchedule(ctx.db, campaignId, opts);
  const done = [];
  const errors = [];
  for (const p of plan) {
    try {
      scheduleAsset(ctx, p.assetId, { runAt: p.runAt });
      done.push(p);
    } catch (e) {
      errors.push({ assetId: p.assetId, error: e.message });
    }
  }
  return { timezone, scheduled: done, unscheduled, errors };
}

export function bulkTransition(ctx, campaignId, { assetIds = [], to, note }) {
  if (!['APPROVED', 'NEEDS_REVIEW'].includes(to)) throw new HttpError(400, 'Bulk action supports approve or submit for review');
  const results = { ok: [], errors: [] };
  for (const assetId of assetIds) {
    const a = ctx.db.byId('creative_assets', assetId);
    if (!a || a.campaign_id !== campaignId) {
      results.errors.push({ assetId, error: 'Not in this campaign' });
      continue;
    }
    try {
      transitionAsset(ctx, assetId, to, { note: note || 'Bulk action' });
      results.ok.push(assetId);
    } catch (e) {
      results.errors.push({ assetId, error: e.message });
    }
  }
  return results;
}
