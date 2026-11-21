#!/usr/bin/env node
/**
 * Sign and send a test webhook — also a reference for integrating your app.
 *
 *   node scripts/send-webhook.js conversion     --workspace ws_123 --secret whsec_... [--content reel-abc123def456-v1] [--campaign relay_2_0_launch] [--source instagram]
 *   node scripts/send-webhook.js product-update --workspace ws_123 --secret whsec_... --title "Relay AI digests" --feature "AI digest: summarises threads"
 *
 * Signature: X-LaunchLoop-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>
 */
import crypto from 'node:crypto';

const [type, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i].replace(/^--/, '');
  (args[k] ||= []).push(rest[i + 1]);
}
const one = (k, d) => args[k]?.[0] ?? d;
if (!['conversion', 'product-update'].includes(type) || !one('workspace') || !one('secret')) {
  console.error('Usage: send-webhook.js <conversion|product-update> --workspace <id> --secret <whsec_…> [options]');
  process.exit(1);
}
const base = one('url', process.env.PUBLIC_BASE_URL || 'http://localhost:3000');
const payload =
  type === 'conversion'
    ? { workspace_id: one('workspace'), event: one('event', 'signup'), utm_source: one('source'), utm_campaign: one('campaign'), utm_content: one('content'), occurred_at: new Date().toISOString() }
    : { workspace_id: one('workspace'), event: one('event', 'feature_released'), title: one('title', 'New feature'), summary: one('summary', ''), features: args.feature || [], url: one('link') };
const raw = JSON.stringify(payload);
const t = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac('sha256', one('secret')).update(`${t}.${raw}`).digest('hex');
const res = await fetch(`${base}/api/webhooks/${type}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-launchloop-signature': `t=${t},v1=${sig}`, 'x-launchloop-event-id': one('event-id', crypto.randomUUID()) },
  body: raw,
});
console.log(res.status, await res.text());
