import { HttpError, slugify } from '../lib/util.js';

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
const clean = (v) => slugify(v).replace(/-/g, '_');

/**
 * Append clean UTM parameters. Existing non-UTM query params and the hash are
 * preserved; any existing utm_* params are replaced so links never double-tag.
 */
export function buildUtmUrl(baseUrl, { source, medium = 'social', campaign, content, term } = {}) {
  let u;
  try {
    u = new URL(String(baseUrl).trim());
  } catch {
    throw new HttpError(400, `Invalid URL: ${baseUrl}`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'Only http(s) URLs can be tagged');
  for (const k of UTM_KEYS) u.searchParams.delete(k);
  const params = { utm_source: source, utm_medium: medium, utm_campaign: campaign, utm_term: term, utm_content: content };
  for (const [k, v] of Object.entries(params)) {
    if (v) u.searchParams.set(k, k === 'utm_content' ? String(v).toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : clean(v));
  }
  return u.toString();
}

/** utm_content carries `<format>-<assetIdHex>-v<version>` so conversions map back to a creative. */
export const utmContentFor = (asset) => `${asset.format}-${asset.id.replace(/^ast_/, '')}-v${asset.version}`;

export function parseUtmContent(content) {
  const m = String(content || '').match(/^([a-z]+)-([a-f0-9]{12})-v(\d+)$/);
  return m ? { format: m[1], assetId: `ast_${m[2]}`, version: Number(m[3]) } : null;
}

export function assetUtmUrl(asset, campaign, workspace) {
  const base = campaign.base_url || workspace.website_url;
  if (!base) return null;
  return buildUtmUrl(base, {
    source: asset.channel,
    medium: asset.format === 'reel' || asset.format === 'video' ? 'social_video' : 'social',
    campaign: campaign.utm_campaign,
    content: utmContentFor(asset),
  });
}
