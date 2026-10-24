'use strict';
// Database: SQLite built into Node.js (node:sqlite). One file, no server to run.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  business_name TEXT DEFAULT '',
  company_number TEXT DEFAULT '',
  business_address TEXT DEFAULT '',
  privacy_url TEXT DEFAULT '',
  opt_out_text TEXT DEFAULT 'If you''d rather not hear from me, just reply and let me know.',
  timezone TEXT DEFAULT 'Europe/London',
  retention_months INTEGER DEFAULT 12,
  adzuna_app_id TEXT DEFAULT '',
  adzuna_app_key TEXT DEFAULT '',
  plan TEXT DEFAULT 'trial',
  trial_ends_at INTEGER,
  extra_seats INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id TEXT DEFAULT '',
  stripe_subscription_id TEXT DEFAULT '',
  sub_status TEXT DEFAULT '',
  period_end INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  theme TEXT NOT NULL DEFAULT 'system',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS inboxes (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  from_name TEXT NOT NULL,
  signature TEXT DEFAULT '',
  smtp_host TEXT NOT NULL,
  smtp_port INTEGER NOT NULL,
  imap_host TEXT NOT NULL,
  imap_port INTEGER NOT NULL,
  username TEXT NOT NULL,
  pass_enc TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 30,
  ramp_start INTEGER NOT NULL DEFAULT 10,
  ramp_step INTEGER NOT NULL DEFAULT 2,
  started_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT DEFAULT '',
  last_uid INTEGER DEFAULT 0,
  uid_validity TEXT DEFAULT '',
  last_polled_at INTEGER DEFAULT 0,
  next_send_at INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sends (
  inbox_id INTEGER NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (inbox_id, day)
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  company TEXT DEFAULT '',
  title TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  website TEXT DEFAULT '',
  source TEXT DEFAULT '',
  personal_line TEXT DEFAULT '',
  custom_json TEXT DEFAULT '{}',
  consent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  unsubscribe_token TEXT NOT NULL,
  last_activity_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, email)
);
CREATE INDEX IF NOT EXISTS leads_ws ON leads(workspace_id, status);

CREATE TABLE IF NOT EXISTS suppression (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, value)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  start_hour INTEGER NOT NULL DEFAULT 8,
  end_hour INTEGER NOT NULL DEFAULT 16,
  one_per_company INTEGER NOT NULL DEFAULT 1,
  lia_purpose TEXT DEFAULT '',
  lia_relevance TEXT DEFAULT '',
  lia_balance TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  launched_at INTEGER
);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  type TEXT NOT NULL,
  delay_days INTEGER NOT NULL DEFAULT 0,
  subject TEXT DEFAULT '',
  body TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS campaign_inboxes (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  inbox_id INTEGER NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, inbox_id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  current_step INTEGER NOT NULL DEFAULT 0,
  next_due_at INTEGER NOT NULL DEFAULT 0,
  inbox_id INTEGER REFERENCES inboxes(id) ON DELETE SET NULL,
  first_message_id TEXT DEFAULT '',
  last_message_id TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX IF NOT EXISTS enr_due ON enrollments(status, next_due_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE SET NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  inbox_id INTEGER REFERENCES inboxes(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  step_position INTEGER,
  message_id TEXT DEFAULT '',
  in_reply_to TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  body_text TEXT DEFAULT '',
  from_email TEXT DEFAULT '',
  to_email TEXT DEFAULT '',
  label TEXT DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_ws ON messages(workspace_id, direction, created_at);
CREATE INDEX IF NOT EXISTS msg_mid ON messages(message_id);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  enrollment_id INTEGER REFERENCES enrollments(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  step_position INTEGER,
  kind TEXT NOT NULL DEFAULT 'call',
  reason TEXT DEFAULT '',
  script TEXT DEFAULT '',
  due_day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  outcome TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  completed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_ws ON tasks(workspace_id, status, due_day);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company TEXT NOT NULL,
  job_title TEXT NOT NULL,
  location TEXT DEFAULT '',
  posted_at TEXT DEFAULT '',
  url TEXT NOT NULL,
  source TEXT DEFAULT 'Adzuna',
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, url)
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  email TEXT DEFAULT '',
  detail TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_ws ON audit(workspace_id, at);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  // Small migrations for databases created by earlier versions.
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('users').includes('theme')) db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'system'");
  const wsCols = cols('workspaces');
  const addWs = { trial_ends_at: 'INTEGER', extra_seats: 'INTEGER NOT NULL DEFAULT 0', stripe_customer_id: "TEXT DEFAULT ''", stripe_subscription_id: "TEXT DEFAULT ''", sub_status: "TEXT DEFAULT ''", period_end: 'INTEGER' };
  for (const [k, def] of Object.entries(addWs)) if (!wsCols.includes(k)) db.exec(`ALTER TABLE workspaces ADD COLUMN ${k} ${def}`);
  return wrap(db);
}

// Small helpers so the rest of the code stays readable.
function wrap(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = db.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  return {
    raw: db,
    get: (sql, ...p) => stmt(sql).get(...clean(p)),
    all: (sql, ...p) => stmt(sql).all(...clean(p)),
    run: (sql, ...p) => stmt(sql).run(...clean(p)),
    exec: (sql) => db.exec(sql),
    tx(fn) {
      db.exec('BEGIN');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    audit(ws, actor, action, email, detail) {
      stmt('INSERT INTO audit (workspace_id, at, actor, action, email, detail) VALUES (?,?,?,?,?,?)')
        .run(ws, Date.now(), actor, action, email || '', detail || '');
    }
  };
}

module.exports = { open };
