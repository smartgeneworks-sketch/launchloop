/**
 * Reminders by email (Resend) and WhatsApp (Meta WhatsApp Cloud API).
 *
 * Events: post due (Share Kit), publish failed, daily digest. Every message is logged in
 * `notifications` with a dedupe key, so the same reminder is never sent twice per channel.
 * Missing provider keys never break anything — that channel just reports "not configured".
 */
import { CHANNELS } from '../lib/channels.js';
import { HttpError, id, isoDate, nowIso } from '../lib/util.js';

export const DEFAULT_SETTINGS = {
  email: '',
  whatsapp: '',
  channels: { email: true, whatsapp: true },
  events: { postDue: true, publishFailed: true, digest: true },
  digestTime: '08:00',
  timezone: '',
};

const REGION_TZ = { GH: 'Africa/Accra', NG: 'Africa/Lagos', KE: 'Africa/Nairobi', ZA: 'Africa/Johannesburg', EG: 'Africa/Cairo', MA: 'Africa/Casablanca', SN: 'Africa/Dakar', CI: 'Africa/Abidjan', TZ: 'Africa/Dar_es_Salaam', UG: 'Africa/Kampala', RW: 'Africa/Kigali', ET: 'Africa/Addis_Ababa', CM: 'Africa/Douala', GB: 'Europe/London', IS: 'Atlantic/Reykjavik', US: 'America/New_York', IN: 'Asia/Kolkata' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** WhatsApp template parameters may not contain newlines, tabs or 4+ spaces. */
const waParam = (s, max = 600) => String(s ?? '').replace(/[\n\t]+/g, ' · ').replace(/ {4,}/g, '   ').trim().slice(0, max) || '-';

function localParts(date, timeZone) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
  } catch {
    const iso = date.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
}

export class Notifier {
  constructor({ db, config, fetchImpl = globalThis.fetch }) {
    this.db = db;
    this.config = config;
    this.env = config.env || {};
    this.fetch = fetchImpl;
  }

  // ---------------------------------------------------------------- configuration
  providers() {
    return {
      email: { configured: !!(this.env.RESEND_API_KEY && this.env.NOTIFY_EMAIL_FROM), provider: 'Resend', from: this.env.NOTIFY_EMAIL_FROM || null },
      whatsapp: { configured: !!(this.env.WHATSAPP_TOKEN && this.env.WHATSAPP_PHONE_NUMBER_ID), provider: 'WhatsApp Cloud API', template: this.env.WHATSAPP_TEMPLATE || 'launchloop_reminder' },
    };
  }

  settings(ws) {
    const row = this.db.get(null, 'SELECT settings FROM notification_settings WHERE workspace_id = ?', ws.id);
    const saved = row ? JSON.parse(row.settings) : {};
    const s = { ...DEFAULT_SETTINGS, ...saved, channels: { ...DEFAULT_SETTINGS.channels, ...saved.channels }, events: { ...DEFAULT_SETTINGS.events, ...saved.events } };
    if (!s.timezone) s.timezone = REGION_TZ[ws.locale?.region] || 'UTC';
    return s;
  }

  saveSettings(ws, patch = {}) {
    const cur = this.settings(ws);
    const next = { ...cur, ...patch, channels: { ...cur.channels, ...patch.channels }, events: { ...cur.events, ...patch.events } };
    next.email = String(next.email || '').trim().slice(0, 200);
    if (next.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(next.email)) throw new HttpError(400, 'Enter a valid email address');
    next.whatsapp = String(next.whatsapp || '').replace(/[^\d+]/g, '');
    if (next.whatsapp && !/^\+?[1-9]\d{7,14}$/.test(next.whatsapp)) throw new HttpError(400, 'Enter the WhatsApp number with country code, e.g. +233241234567');
    if (next.whatsapp && !next.whatsapp.startsWith('+')) next.whatsapp = '+' + next.whatsapp;
    if (!/^\d{2}:\d{2}$/.test(next.digestTime)) throw new HttpError(400, 'Digest time must be HH:MM');
    try {
      new Intl.DateTimeFormat('en', { timeZone: next.timezone });
    } catch {
      throw new HttpError(400, 'Unknown time zone');
    }
    this.db.run('INSERT INTO notification_settings (workspace_id, settings, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at', ws.id, JSON.stringify(next), nowIso());
    return next;
  }

  log(ws, limit = 30) {
    return this.db.all(null, 'SELECT * FROM notifications WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?', ws.id, limit);
  }

  link(hash = '#/') {
    return `${String(this.config.publicBaseUrl || '').replace(/\/$/, '')}/${hash}`;
  }

  // ---------------------------------------------------------------- transports
  async sendEmail(to, { subject, title, lines = [], link, linkLabel = 'Open LaunchLoop' }) {
    if (!this.providers().email.configured) throw new Error('Email not configured (RESEND_API_KEY / NOTIFY_EMAIL_FROM)');
    const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;color:#121212">
      <div style="font-size:13px;color:#57739e;font-weight:600;letter-spacing:.06em;text-transform:uppercase">LaunchLoop</div>
      <h2 style="font-size:20px;margin:6px 0 12px">${esc(title)}</h2>
      ${lines.map((l) => `<p style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#333">${esc(l)}</p>`).join('')}
      ${link ? `<p style="margin:18px 0"><a href="${esc(link)}" style="background:#57739e;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;font-size:14px">${esc(linkLabel)}</a></p>` : ''}
      <p style="font-size:12px;color:#888;margin-top:24px">You get this because reminders are on for this workspace. Change them in LaunchLoop → Product source → Reminders.</p></div>`;
    const res = await this.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.env.NOTIFY_EMAIL_FROM, to: [to], subject, html, text: [title, ...lines, link ? `${linkLabel}: ${link}` : ''].join('\n\n') }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json().catch(() => ({}))).id || 'sent';
  }

  /**
   * Business-initiated WhatsApp messages need an approved template (see docs/REMINDERS.md).
   * Template "launchloop_reminder" (Utility, English), body with 3 variables:
   *   "Hi, this is your LaunchLoop reminder: {{1}}. Details: {{2}}. Open LaunchLoop to take action: {{3}}. You can change these reminders anytime in your LaunchLoop settings."
   */
  async sendWhatsApp(to, { title, lines = [], link }) {
    if (!this.providers().whatsapp.configured) throw new Error('WhatsApp not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)');
    const version = this.env.WHATSAPP_API_VERSION || 'v21.0';
    const template = this.env.WHATSAPP_TEMPLATE || 'launchloop_reminder';
    const body =
      template === 'none'
        ? { messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'text', text: { body: [`*${title}*`, ...lines, link || ''].join('\n') } }
        : {
            messaging_product: 'whatsapp',
            to: to.replace('+', ''),
            type: 'template',
            template: {
              name: template,
              language: { code: this.env.WHATSAPP_TEMPLATE_LANG || 'en' },
              components: [{ type: 'body', parameters: [waParam(title, 200), waParam(lines.join(' · '), 700), waParam(link || this.link(), 300)].map((text) => ({ type: 'text', text })) }],
            },
          };
    const res = await this.fetch(`https://graph.facebook.com/${version}/${this.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${data.error?.message || 'error'}`);
    return data.messages?.[0]?.id || 'sent';
  }

  // ---------------------------------------------------------------- dispatch
  /** Send one reminder to every enabled channel, once per (key, channel). */
  async notify(ws, { kind, key, subject, title, lines, link, linkLabel, force = false, only = null }) {
    const s = this.settings(ws);
    if (!force && kind !== 'test' && !s.events[kind]) return [];
    const targets = [
      ['email', s.email],
      ['whatsapp', s.whatsapp],
    ].filter(([ch, to]) => to && (!only || ch === only) && (force || s.channels[ch]));
    const results = [];
    for (const [channel, to] of targets) {
      const dedupe = `${key}:${channel}`;
      if (!force && this.db.get(null, `SELECT id FROM notifications WHERE workspace_id = ? AND dedupe_key = ? AND status = 'sent'`, ws.id, dedupe)) continue;
      const row = { id: id('ntf'), workspace_id: ws.id, channel, kind, dedupe_key: force ? `${dedupe}:${Date.now()}` : dedupe, recipient: to, subject: subject || title, status: 'sent', error: null, created_at: nowIso() };
      try {
        row.provider_id = channel === 'email' ? await this.sendEmail(to, { subject: subject || title, title, lines, link, linkLabel }) : await this.sendWhatsApp(to, { title, lines, link });
      } catch (e) {
        row.status = 'failed';
        row.error = e.message.slice(0, 300);
        console.warn(`[notify] ${channel} ${kind} failed: ${e.message}`);
      }
      this.db.insert('notifications', row);
      results.push(row);
    }
    return results;
  }

  // ---------------------------------------------------------------- events
  wsForAsset(asset) {
    return this.db.get('workspaces', 'SELECT w.* FROM workspaces w JOIN campaigns c ON c.workspace_id = w.id WHERE c.id = ?', asset.campaign_id);
  }

  async postDue(asset) {
    const ws = this.wsForAsset(asset);
    if (!ws) return;
    const ch = CHANNELS[asset.channel]?.label || asset.channel;
    return this.notify(ws, {
      kind: 'postDue',
      key: `due:${asset.id}:v${asset.version}`,
      subject: `Time to post on ${ch}: ${asset.title}`,
      title: `Your ${ch} post is due now`,
      lines: [asset.title, `Open the Share Kit to download the media and copy the caption with its tracked link, post it on ${ch}, then click “Mark as published”.`],
      link: this.link(`#/review?kit=${asset.id}`),
      linkLabel: 'Open Share Kit',
    });
  }

  async publishFailed(asset, error) {
    const ws = this.wsForAsset(asset);
    if (!ws) return;
    const ch = CHANNELS[asset.channel]?.label || asset.channel;
    return this.notify(ws, {
      kind: 'publishFailed',
      key: `failed:${asset.id}:v${asset.version}:${isoDate(new Date())}`,
      subject: `Post failed on ${ch}: ${asset.title}`,
      title: `A ${ch} post failed to publish`,
      lines: [asset.title, `Error: ${error || 'unknown'}`, 'Retry it, or post it manually with the Share Kit.'],
      link: this.link(`#/review?kit=${asset.id}`),
      linkLabel: 'Fix it',
    });
  }

  digestFor(ws, localDate, timeZone) {
    const db = this.db;
    const campaigns = db.all('campaigns', `SELECT * FROM campaigns WHERE workspace_id = ? AND status = 'active'`, ws.id);
    const ids = campaigns.map((c) => c.id);
    if (!ids.length) return null;
    const ph = ids.map(() => '?').join(',');
    const inDay = (iso) => iso && localParts(new Date(iso), timeZone).date === localDate;
    const scheduled = db.all(null, `SELECT a.id, a.title, a.channel, a.scheduled_at, a.auto_publish FROM creative_assets a WHERE a.campaign_id IN (${ph}) AND a.state = 'SCHEDULED'`, ...ids).filter((a) => inDay(a.scheduled_at));
    const conns = Object.fromEntries(db.all('channel_connections', 'SELECT * FROM channel_connections WHERE workspace_id = ?', ws.id).map((c) => [c.channel, c]));
    const manual = scheduled.filter((a) => !(a.auto_publish && conns[a.channel]?.mode === 'api' && conns[a.channel]?.auto_publish));
    const overdue = db.all(null, `SELECT title FROM campaign_tasks WHERE campaign_id IN (${ph}) AND done = 0 AND due_date < ?`, ...ids, localDate);
    const dueToday = db.all(null, `SELECT title FROM campaign_tasks WHERE campaign_id IN (${ph}) AND done = 0 AND due_date = ?`, ...ids, localDate);
    const review = db.scalar(`SELECT COUNT(*) FROM creative_assets WHERE campaign_id IN (${ph}) AND state = 'NEEDS_REVIEW'`, ...ids);
    const failed = db.scalar(`SELECT COUNT(*) FROM creative_assets WHERE campaign_id IN (${ph}) AND state = 'FAILED'`, ...ids);
    const y = new Date(new Date(localDate + 'T12:00:00Z').getTime() - 86_400_000).toISOString().slice(0, 10);
    const signups = db.scalar(`SELECT COALESCE(SUM(signups),0) FROM campaign_metrics WHERE campaign_id IN (${ph}) AND date = ?`, ...ids, y);
    if (!scheduled.length && !overdue.length && !dueToday.length && !review && !failed) return null;
    const time = (iso) => localParts(new Date(iso), timeZone).time;
    const lines = [];
    if (scheduled.length) lines.push(`Posts today (${scheduled.length}): ${scheduled.map((a) => `${time(a.scheduled_at)} ${CHANNELS[a.channel]?.label || a.channel}${manual.includes(a) ? ' (Share Kit)' : ''}`).join(', ')}`);
    if (manual.length) lines.push(`${manual.length} need you to post them with the Share Kit — you'll get a reminder at each time.`);
    if (dueToday.length) lines.push(`Tasks due today (${dueToday.length}): ${dueToday.slice(0, 4).map((t) => t.title).join('; ')}${dueToday.length > 4 ? '…' : ''}`);
    if (overdue.length) lines.push(`Overdue tasks: ${overdue.length}`);
    if (review) lines.push(`Waiting for your review: ${review} creative(s)`);
    if (failed) lines.push(`Failed posts to fix: ${failed}`);
    lines.push(`Signups yesterday: ${signups}`);
    return { lines, counts: { scheduled: scheduled.length, manual: manual.length, overdue: overdue.length, review, failed } };
  }

  /** Called from every worker tick; sends each workspace's digest once per local day. */
  async digestTick(now = new Date()) {
    for (const ws of this.db.all('workspaces', 'SELECT * FROM workspaces')) {
      const s = this.settings(ws);
      if (!s.events.digest || (!s.email && !s.whatsapp)) continue;
      const local = localParts(now, s.timezone);
      if (local.time < s.digestTime) continue;
      if (this.db.get(null, `SELECT id FROM notifications WHERE workspace_id = ? AND dedupe_key LIKE ? AND kind = 'digest'`, ws.id, `digest:${local.date}:%`)) continue;
      const d = this.digestFor(ws, local.date, s.timezone);
      if (!d) {
        this.db.insert('notifications', { id: id('ntf'), workspace_id: ws.id, channel: 'none', kind: 'digest', dedupe_key: `digest:${local.date}:skipped`, recipient: '', subject: 'Nothing scheduled today', status: 'skipped', error: null, created_at: nowIso() });
        continue;
      }
      await this.notify(ws, { kind: 'digest', key: `digest:${local.date}`, subject: `LaunchLoop today: ${d.counts.scheduled} post(s), ${d.counts.overdue} overdue task(s)`, title: `Your LaunchLoop plan for today`, lines: d.lines, link: this.link('#/'), linkLabel: 'Open dashboard' });
    }
  }
}
