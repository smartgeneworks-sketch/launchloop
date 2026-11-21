/**
 * Channel catalog. `api` describes the official publishing route; `defaultMode`
 * is what a new workspace gets. Channels without a usable official publishing
 * API (or whose API needs an audit most users won't have) default to the
 * One-Tap Share Kit — we never scrape or automate a UI to get around this.
 */
export const CHANNELS = {
  instagram: {
    label: 'Instagram',
    api: 'Instagram Graph API — Content Publishing',
    apiAvailable: true,
    defaultMode: 'api',
    requirements: 'Instagram Business/Creator account linked to a Facebook Page; Meta app review for content publishing; media must be on a public URL.',
    captionLimit: 2200,
    hashtagLimit: 8,
    linkInCaption: false,
    formats: { reel: '9:16', post: '4:5', carousel: '4:5', flyer: '4:5' },
  },
  tiktok: {
    label: 'TikTok',
    api: 'TikTok Content Posting API',
    apiAvailable: true,
    defaultMode: 'share_kit',
    requirements: 'Content Posting API access; unaudited apps can only post privately, so public posting needs TikTok\'s audit. Share Kit until then.',
    captionLimit: 2200,
    hashtagLimit: 5,
    linkInCaption: false,
    formats: { reel: '9:16' },
  },
  youtube_shorts: {
    label: 'YouTube Shorts',
    api: 'YouTube Data API v3 — videos.insert',
    apiAvailable: true,
    defaultMode: 'api',
    requirements: 'Google OAuth consent screen with youtube.upload scope; unverified apps upload as private.',
    captionLimit: 5000,
    hashtagLimit: 3,
    linkInCaption: true,
    formats: { reel: '9:16' },
  },
  linkedin: {
    label: 'LinkedIn',
    api: 'LinkedIn Posts API (Community Management)',
    apiAvailable: true,
    defaultMode: 'api',
    requirements: 'LinkedIn app with w_member_social (personal) or Community Management API approval (company pages).',
    captionLimit: 3000,
    hashtagLimit: 4,
    linkInCaption: true,
    formats: { post: '1.91:1', carousel: '1:1', video: '16:9', flyer: '1:1' },
  },
  x: {
    label: 'X',
    api: 'X API v2 — POST /2/tweets',
    apiAvailable: true,
    defaultMode: 'api',
    requirements: 'X developer project on a tier that allows posting; OAuth 2.0 user token with tweet.write.',
    captionLimit: 280,
    hashtagLimit: 2,
    linkInCaption: true,
    formats: { post: '16:9', video: '16:9', flyer: '16:9' },
  },
  facebook: {
    label: 'Facebook',
    api: 'Facebook Pages API',
    apiAvailable: true,
    defaultMode: 'api',
    requirements: 'Facebook Page + Page access token with pages_manage_posts (app review).',
    captionLimit: 5000,
    hashtagLimit: 3,
    linkInCaption: true,
    formats: { post: '1.91:1', reel: '9:16', flyer: '4:5', video: '16:9' },
  },
  threads: {
    label: 'Threads',
    api: 'Threads API',
    apiAvailable: true,
    defaultMode: 'share_kit',
    requirements: 'Threads API access via a Meta app (threads_content_publish).',
    captionLimit: 500,
    hashtagLimit: 1,
    linkInCaption: true,
    formats: { post: '4:5' },
  },
  reddit: {
    label: 'Reddit',
    api: null,
    apiAvailable: false,
    defaultMode: 'share_kit',
    requirements: 'Manual by design: every subreddit has its own self-promotion rules. Post by hand after reading them.',
    captionLimit: 40000,
    hashtagLimit: 0,
    linkInCaption: true,
    formats: { post: '16:9' },
  },
  product_hunt: {
    label: 'Product Hunt',
    api: null,
    apiAvailable: false,
    defaultMode: 'share_kit',
    requirements: 'No public posting API for launches — use the Share Kit (gallery images, tagline, first comment).',
    captionLimit: 260,
    hashtagLimit: 0,
    linkInCaption: true,
    formats: { post: '16:9', flyer: '16:9' },
  },
};

export const FORMATS = {
  reel: { label: 'Reel', kind: 'video', durationSec: 22 },
  video: { label: 'Short video', kind: 'video', durationSec: 45 },
  flyer: { label: 'Flyer', kind: 'image' },
  post: { label: 'Social post', kind: 'image' },
  carousel: { label: 'Carousel', kind: 'image' },
};

export const ASPECTS = {
  '9:16': [1080, 1920],
  '4:5': [1080, 1350],
  '1:1': [1080, 1080],
  '16:9': [1600, 900],
  '1.91:1': [1200, 628],
};

export const TASK_CATEGORIES = ['Setup', 'Creative Review', 'Publishing', 'Community/Viral Actions', 'Analytics Review'];

/** Specs (channel × format) for a set of channels, optionally limited to formats. */
export function specsFor(channels, formats) {
  const out = [];
  for (const ch of channels) {
    const c = CHANNELS[ch];
    if (!c) continue;
    for (const [fmt, aspect] of Object.entries(c.formats)) {
      if (formats && formats.length && !formats.includes(fmt)) continue;
      out.push({ channel: ch, format: fmt, aspect_ratio: aspect });
    }
  }
  return out;
}
