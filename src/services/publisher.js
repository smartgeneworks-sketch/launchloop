/**
 * Publishing adapters. In `mock` mode API-mode channels publish through a
 * simulated adapter (no network). In `live` mode we call the official API for
 * channels that have credentials configured; channels without a live adapter
 * (or without credentials) are routed to the Share Kit instead of failing.
 */
import { CHANNELS } from '../lib/channels.js';

export class ManualRequired extends Error {
  constructor(message) {
    super(message);
    this.manual = true;
  }
}

/** Resolve {{link}} and append hashtags within the platform limit. */
export function finalCaption(asset) {
  const ch = CHANNELS[asset.channel] || { captionLimit: 2200 };
  let caption = String(asset.caption || '').replace(/\{\{link\}\}/g, asset.utm_url || '');
  const tags = (asset.hashtags || []).join(' ');
  if (tags && !caption.includes(tags)) caption = `${caption}\n\n${tags}`;
  if (caption.length > ch.captionLimit) caption = caption.slice(0, ch.captionLimit - 1) + '…';
  return caption.trim();
}

const live = {
  /** X API v2 — text post with the tracked link (media upload left as an extension point). */
  async x({ asset, env, fetchImpl }) {
    if (!env.X_USER_ACCESS_TOKEN) throw new ManualRequired('X_USER_ACCESS_TOKEN not configured');
    const res = await fetchImpl('https://api.x.com/2/tweets', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.X_USER_ACCESS_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: finalCaption(asset) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`X API ${res.status}: ${body.detail || body.title || 'error'}`);
    return { externalId: body.data?.id, url: body.data?.id ? `https://x.com/i/web/status/${body.data.id}` : null };
  },
  /** LinkedIn Posts API — text/article post. */
  async linkedin({ asset, env, fetchImpl }) {
    if (!env.LINKEDIN_ACCESS_TOKEN || !env.LINKEDIN_AUTHOR_URN) throw new ManualRequired('LinkedIn credentials not configured');
    const res = await fetchImpl('https://api.linkedin.com/rest/posts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.LINKEDIN_ACCESS_TOKEN}`,
        'content-type': 'application/json',
        'LinkedIn-Version': env.LINKEDIN_API_VERSION || '202410',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({
        author: env.LINKEDIN_AUTHOR_URN,
        commentary: finalCaption(asset),
        visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
      }),
    });
    if (!res.ok) throw new Error(`LinkedIn API ${res.status}`);
    const urn = res.headers.get('x-restli-id');
    return { externalId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null };
  },
  /** Telegram Bot API — posts to a channel where the bot is an admin. Text + link preview. */
  async telegram({ asset, env, fetchImpl }) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new ManualRequired('Telegram bot not configured');
    const res = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: finalCaption(asset).slice(0, 4096), link_preview_options: { is_disabled: false } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(`Telegram ${res.status}: ${body.description || 'error'}`);
    const chat = String(env.TELEGRAM_CHAT_ID);
    return { externalId: String(body.result?.message_id), url: chat.startsWith('@') ? `https://t.me/${chat.slice(1)}/${body.result?.message_id}` : null };
  },
  // Instagram, Facebook, YouTube, TikTok and Threads need a rendered media file on
  // a public URL (and, for video, an MP4 render). Until a renderer is wired up these
  // fall through to the Share Kit. See docs/ARCHITECTURE.md → "Going live".
};

export class Publisher {
  constructor({ mode = 'mock', failureRate = 0.1, env = process.env, fetchImpl = globalThis.fetch, random = Math.random } = {}) {
    Object.assign(this, { mode, failureRate, env, fetchImpl, random });
  }

  async publish({ asset, connection }) {
    if (!connection || connection.mode !== 'api' || connection.status === 'disconnected') {
      throw new ManualRequired(`${CHANNELS[asset.channel]?.label || asset.channel} is set to Share Kit (manual publishing)`);
    }
    if (this.mode === 'mock') {
      await new Promise((r) => setTimeout(r, 30));
      if (this.random() < this.failureRate) throw new Error('Simulated platform error: 503 upstream unavailable (mock)');
      const extId = `mock_${asset.channel}_${Date.now().toString(36)}`;
      return { externalId: extId, url: `https://example.com/mock/${asset.channel}/${extId}`, simulated: true };
    }
    const adapter = live[asset.channel];
    if (!adapter) throw new ManualRequired(`No live adapter for ${CHANNELS[asset.channel]?.label || asset.channel} yet — publish via Share Kit`);
    return adapter({ asset, env: this.env, fetchImpl: this.fetchImpl });
  }
}
