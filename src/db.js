import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './lib/util.js';

const STATES = `'DRAFT','NEEDS_REVIEW','APPROVED','SCHEDULED','PUBLISHED','FAILED','NEEDS_REVISION'`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  website_url TEXT,
  tagline TEXT,
  description TEXT,
  features TEXT NOT NULL DEFAULT '[]',
  value_props TEXT NOT NULL DEFAULT '[]',
  pain_points TEXT NOT NULL DEFAULT '[]',
  hooks TEXT NOT NULL DEFAULT '[]',
  audience TEXT,
  pricing TEXT,
  offer TEXT,
  referral_mechanics TEXT,
  brand TEXT NOT NULL DEFAULT '{}',
  locale TEXT NOT NULL DEFAULT '{}',
  screenshots TEXT NOT NULL DEFAULT '[]',
  source_meta TEXT NOT NULL DEFAULT '{}',
  webhook_secret TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  goal TEXT,
  base_url TEXT,
  utm_campaign TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT '[]',
  launch_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planning','active','completed','archived')),
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS creative_assets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('reel','video','flyer','post','carousel')),
  aspect_ratio TEXT NOT NULL,
  title TEXT NOT NULL,
  headline TEXT,
  caption TEXT,
  cta TEXT,
  hashtags TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'DRAFT' CHECK (state IN (${STATES})),
  score TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  parent_id TEXT REFERENCES creative_assets(id) ON DELETE SET NULL,
  scheduled_at TEXT,
  auto_publish INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,
  external_url TEXT,
  error TEXT,
  review_note TEXT,
  generator TEXT,
  utm_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_campaign ON creative_assets(campaign_id, state);

CREATE TABLE IF NOT EXISTS asset_events (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES creative_assets(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES creative_assets(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','retry','done','failed','manual_required','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  log TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON schedule_jobs(status, run_at);

CREATE TABLE IF NOT EXISTS campaign_tasks (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('Setup','Creative Review','Publishing','Community/Viral Actions','Analytics Review')),
  role TEXT,
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  source TEXT NOT NULL DEFAULT 'auto',
  asset_id TEXT REFERENCES creative_assets(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('api','share_kit')),
  status TEXT NOT NULL CHECK (status IN ('connected','mock','disconnected')),
  account_label TEXT,
  auto_publish INTEGER NOT NULL DEFAULT 0,
  token_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, channel)
);

CREATE TABLE IF NOT EXISTS campaign_metrics (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  asset_id TEXT REFERENCES creative_assets(id) ON DELETE SET NULL,
  channel TEXT,
  date TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  signups INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK (source IN ('simulated','manual','webhook','api')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_campaign ON campaign_metrics(campaign_id, asset_id);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT,
  label TEXT,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_ws ON media(workspace_id);

CREATE TABLE IF NOT EXISTS notification_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  recipient TEXT,
  subject TEXT,
  status TEXT NOT NULL,
  error TEXT,
  provider_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_ws ON notifications(workspace_id, dedupe_key);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  result TEXT,
  received_at TEXT NOT NULL
);
`;

const JSON_COLS = {
  workspaces: ['features', 'value_props', 'pain_points', 'hooks', 'brand', 'locale', 'screenshots', 'source_meta'],
  campaigns: ['channels'],
  creative_assets: ['hashtags', 'content', 'score'],
  schedule_jobs: ['log'],
  webhook_events: ['payload', 'result'],
};
const BOOL_COLS = {
  creative_assets: ['auto_publish'],
  campaign_tasks: ['done'],
  channel_connections: ['auto_publish'],
};
const HAS_UPDATED_AT = new Set(['workspaces', 'campaigns', 'creative_assets', 'schedule_jobs', 'campaign_tasks', 'channel_connections']);

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(SCHEMA);
  // Additive migrations for databases created by earlier versions.
  for (const sql of ['ALTER TABLE media ADD COLUMN path TEXT', 'ALTER TABLE media ADD COLUMN kind TEXT', 'ALTER TABLE media ADD COLUMN duration REAL', 'ALTER TABLE media ADD COLUMN poster TEXT']) {
    try {
      raw.exec(sql);
    } catch {
      /* column already exists */
    }
  }
  return wrap(raw);
}

function wrap(raw) {
  const ser = (table, col, v) => {
    if (v === undefined) return null;
    if ((JSON_COLS[table] || []).includes(col)) return v === null ? null : JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  };
  const hydrate = (table, row) => {
    if (!row) return row;
    const out = { ...row };
    for (const c of JSON_COLS[table] || []) if (out[c] != null) out[c] = JSON.parse(out[c]);
    for (const c of BOOL_COLS[table] || []) if (c in out) out[c] = !!out[c];
    return out;
  };
  const db = {
    raw,
    all: (table, sql, ...p) => raw.prepare(sql).all(...p).map((r) => hydrate(table, r)),
    get: (table, sql, ...p) => hydrate(table, raw.prepare(sql).get(...p)),
    run: (sql, ...p) => raw.prepare(sql).run(...p),
    scalar: (sql, ...p) => {
      const r = raw.prepare(sql).get(...p);
      return r ? Object.values(r)[0] : undefined;
    },
    byId: (table, id) => hydrate(table, raw.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)),
    insert(table, obj) {
      const row = { ...obj };
      if (HAS_UPDATED_AT.has(table)) {
        row.created_at ??= nowIso();
        row.updated_at ??= row.created_at;
      }
      const cols = Object.keys(row);
      raw
        .prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map((c) => ser(table, c, row[c])));
      return db.byId(table, row.id);
    },
    update(table, id, patch) {
      const row = { ...patch };
      if (HAS_UPDATED_AT.has(table)) row.updated_at = nowIso();
      const cols = Object.keys(row);
      if (!cols.length) return db.byId(table, id);
      raw
        .prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...cols.map((c) => ser(table, c, row[c])), id);
      return db.byId(table, id);
    },
    tx(fn) {
      raw.exec('BEGIN');
      try {
        const r = fn();
        raw.exec('COMMIT');
        return r;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return db;
}
