import { HttpError, id, nowIso } from '../lib/util.js';

export const STATES = ['DRAFT', 'NEEDS_REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'NEEDS_REVISION'];

/**
 * Allowed transitions. The key invariant: the only path into SCHEDULED is from
 * APPROVED (or a FAILED retry, which itself was SCHEDULED → so APPROVED first),
 * and any content edit drops an asset back to NEEDS_REVIEW. So nothing can be
 * auto-published unless a human approved exactly the content that goes out.
 */
const TRANSITIONS = {
  DRAFT: ['NEEDS_REVIEW'],
  NEEDS_REVIEW: ['APPROVED', 'NEEDS_REVISION', 'DRAFT'],
  NEEDS_REVISION: ['NEEDS_REVIEW', 'DRAFT'],
  APPROVED: ['SCHEDULED', 'NEEDS_REVIEW', 'NEEDS_REVISION'],
  SCHEDULED: ['PUBLISHED', 'FAILED', 'APPROVED', 'NEEDS_REVIEW'],
  FAILED: ['SCHEDULED', 'NEEDS_REVIEW', 'NEEDS_REVISION'],
  PUBLISHED: [],
};

/** Transitions only certain actors may perform. */
const RESTRICTED = {
  'SCHEDULED>PUBLISHED': ['worker', 'share_kit'], // auto-publish, or user confirming a manual Share Kit post
  'SCHEDULED>FAILED': ['worker'],
};

/** States whose content is frozen; editing them sends the asset back for review. */
export const LOCKED_STATES = new Set(['APPROVED', 'SCHEDULED', 'PUBLISHED']);
/** States that a package regeneration is allowed to overwrite. */
export const REPLACEABLE_STATES = new Set(['DRAFT', 'NEEDS_REVISION']);

export function canTransition(from, to, actor = 'user') {
  if (!TRANSITIONS[from]?.includes(to)) return false;
  const allowed = RESTRICTED[`${from}>${to}`];
  return !allowed || allowed.includes(actor);
}

export function allowedNext(from, actor = 'user') {
  return (TRANSITIONS[from] || []).filter((to) => canTransition(from, to, actor));
}

export function transition(db, asset, to, { actor = 'user', note = null, patch = {} } = {}) {
  if (!STATES.includes(to)) throw new HttpError(400, `Unknown state ${to}`);
  if (!canTransition(asset.state, to, actor)) {
    throw new HttpError(409, `Transition ${asset.state} → ${to} is not allowed for ${actor}`, {
      from: asset.state,
      to,
      allowed: allowedNext(asset.state, actor),
    });
  }
  const extra = { ...patch };
  if (to === 'NEEDS_REVISION' && note) extra.review_note = note;
  if (to === 'APPROVED') extra.review_note = null;
  const updated = db.update('creative_assets', asset.id, { state: to, ...extra });
  db.insert('asset_events', { id: id('evt'), asset_id: asset.id, from_state: asset.state, to_state: to, actor, note, at: nowIso() });
  return updated;
}
