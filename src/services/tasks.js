import { CHANNELS } from '../lib/channels.js';

/** Launch checklist template, offsets in days relative to the campaign launch date. */
export function defaultTasks({ workspace, campaign }) {
  const P = workspace.name || 'the product';
  const manual = (campaign.channels || []).filter((c) => CHANNELS[c] && CHANNELS[c].defaultMode === 'share_kit').map((c) => CHANNELS[c].label);
  const t = (category, role, dayOffset, title, description = '') => ({ category, role, dayOffset, title, description });
  return [
    t('Setup', 'Founder', -10, `Confirm ${P}'s features, audience and offer in the workspace`, 'Review the extracted value props — every creative is generated from these facts.'),
    t('Setup', 'Designer', -10, 'Upload brand kit: logo, colours, fonts and 2–3 product screenshots', 'Screenshots power the show-don’t-tell flyers and posts.'),
    t('Setup', 'Marketer', -9, 'Connect channels and set auto-publish rules per channel', 'API channels can auto-post approved items; others use the Share Kit.'),
    t('Setup', 'Developer', -8, 'Install the conversion webhook and keep UTM params through signup', 'POST /api/webhooks/conversion with utm_* from the landing URL so signups map to creatives.'),
    t('Creative Review', 'Marketer', -7, 'Review reel & short-video scripts and storyboards', 'Check each hook lands in 3 seconds and the demo scene shows the real product.'),
    t('Creative Review', 'Designer', -6, 'Approve flyers and promo graphics', 'High contrast, one headline, one CTA.'),
    t('Creative Review', 'Marketer', -6, 'Approve social posts and carousels', 'Use the Hook & Virality score suggestions before approving.'),
    t('Creative Review', 'Marketer', -3, 'Final QA: tracked links resolve and captions fit each platform'),
    t('Publishing', 'Marketer', -5, 'Schedule teaser posts for the pre-launch window'),
    t('Publishing', 'Marketer', 0, 'Launch day: confirm every auto-published post went live', 'Check the publish log for FAILED items and retry.'),
    ...(manual.length ? [t('Publishing', 'Founder', 0, `Publish Share Kit channels manually: ${manual.join(', ')}`, 'Open each item’s Share Kit — media, caption and checklist are ready.')] : []),
    t('Community/Viral Actions', 'Founder', -2, 'Prepare the shareable asset: a duplicable template or before/after demo', 'Give people something worth forwarding.'),
    t('Community/Viral Actions', 'Founder', -1, 'Brief early users and friends with the referral / invite prompt'),
    t('Community/Viral Actions', 'Community Manager', 0, 'Reply to every comment within the first 2 hours'),
    t('Community/Viral Actions', 'Community Manager', 2, 'Re-share user wins and replies as social proof'),
    t('Analytics Review', 'Marketer', 2, '48-hour review: impressions, clicks, shares and signups per creative'),
    t('Analytics Review', 'Marketer', 3, 'Generate follow-up variations from the top performers', 'Use “Iterate on top performer” in Analytics.'),
    t('Analytics Review', 'Founder', 7, '7-day retro: signups by channel and creative; decide what to double down on'),
  ];
}
