'use strict';
// Gridline.io web server: API + web app, no third-party packages.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('./db');
const { Engine } = require('./engine');
const U = require('./util');
const C = require('./compliance');
const smtp = require('./smtp');
const imap = require('./imap');
const { buildMessage, newMessageId } = require('./mime');
const { renderEmail, renderScript } = require('./render');
const signals = require('./signals');
const griddy = require('./griddy');
const plans = require('./plans');
const { Stripe } = require('./billing');

const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 30;
const MAX_BODY = 5 * 1024 * 1024;

/* ---------------------------------------------------------------- */
/* Tiny router                                                       */
/* ---------------------------------------------------------------- */

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

function createApp({ db, engine, appUrl, secureCookies, transport, sandbox, ai = {}, stripe = null }) {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (m, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };
  const sendTest = transport && transport.send ? transport.send : null;

  /* ---------------- helpers ---------------- */

  function wsFor(user) { return db.get('SELECT * FROM workspaces WHERE id = ?', user.workspace_id); }
  function owned(table, id, wsId) {
    const row = db.get(`SELECT * FROM ${table} WHERE id = ? AND workspace_id = ?`, Number(id), wsId);
    if (!row) throw new HttpError(404, 'Not found.');
    return row;
  }
  function str(v, max = 500) { return String(v ?? '').trim().slice(0, max); }
  function int(v, min, max, dflt) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; }
  function inboxPublic(i) {
    const { pass_enc, ...rest } = i;
    return { ...rest, sent_today: engine.sentToday(i, 'Europe/London'), limit_today: engine.limitToday(i) };
  }
  function makeSession(res, userId) {
    const token = U.randomToken(32);
    db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', U.sha256(token), userId, Date.now() + SESSION_DAYS * 86400000);
    res.setHeader('Set-Cookie', `gl_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secureCookies ? '; Secure' : ''}`);
  }
  function campaignDetail(c) {
    const steps = db.all('SELECT * FROM steps WHERE campaign_id = ? ORDER BY position', c.id);
    const inboxIds = db.all('SELECT inbox_id FROM campaign_inboxes WHERE campaign_id = ?', c.id).map((r) => r.inbox_id);
    const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM enrollments WHERE campaign_id = ? GROUP BY status', c.id).map((r) => [r.status, r.n]));
    const sent = db.get(`SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE enrollment_id IN (SELECT id FROM enrollments WHERE campaign_id = ?) AND direction = 'out'`, c.id).n;
    const replied = db.get(`SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE enrollment_id IN (SELECT id FROM enrollments WHERE campaign_id = ?) AND direction = 'in' AND label NOT IN ('ooo','bounce')`, c.id).n;
    const interested = db.get(`SELECT COUNT(*) n FROM enrollments e JOIN leads l ON l.id = e.lead_id WHERE e.campaign_id = ? AND l.status = 'interested'`, c.id).n;
    const stepStats = db.all(`SELECT step_position, COUNT(*) n FROM messages WHERE direction = 'out' AND enrollment_id IN (SELECT id FROM enrollments WHERE campaign_id = ?) GROUP BY step_position`, c.id);
    const callStats = db.all(`SELECT step_position, COUNT(*) n, SUM(status = 'done') done FROM tasks WHERE campaign_id = ? AND step_position IS NOT NULL GROUP BY step_position`, c.id);
    return { ...c, steps, inbox_ids: inboxIds, counts, contacted: sent, replied, interested, step_stats: stepStats, call_stats: callStats };
  }

  /* ---------------- public ---------------- */

  add('POST', '/api/signup', (req, res, body) => {
    const name = str(body.name, 100), email = U.normEmail(body.email), password = String(body.password || ''), company = str(body.company, 120);
    if (!name || !U.isEmail(email)) throw bad('Enter your name and a valid email address.');
    if (password.length < 10) throw bad('Use a password of at least 10 characters.');
    if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw bad('An account with that email already exists. Log in instead.');
    const userId = db.tx(() => {
      const w = db.run('INSERT INTO workspaces (name, business_name, trial_ends_at, created_at) VALUES (?,?,?,?)', company || name, company, Date.now() + plans.PLANS.trial.days * plans.DAY, Date.now());
      const u = db.run('INSERT INTO users (workspace_id, email, name, pass_hash, created_at) VALUES (?,?,?,?,?)',
        w.lastInsertRowid, email, name, U.hashPassword(password), Date.now());
      seedWorkspace(Number(w.lastInsertRowid));
      return Number(u.lastInsertRowid);
    });
    makeSession(res, userId);
    return { ok: true };
  }, { auth: false });

  const attempts = new Map();
  add('POST', '/api/login', (req, res, body) => {
    const ip = req.socket.remoteAddress || '';
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const user = db.get('SELECT * FROM users WHERE email = ?', U.normEmail(body.email));
    if (!user || !U.verifyPassword(String(body.password || ''), user.pass_hash)) {
      a.n++; attempts.set(ip, a);
      throw new HttpError(401, 'That email and password combination is wrong.');
    }
    attempts.delete(ip);
    makeSession(res, user.id);
    return { ok: true };
  }, { auth: false });

  add('POST', '/api/logout', (req, res, body, ctx) => {
    db.run('DELETE FROM sessions WHERE token_hash = ?', U.sha256(ctx.token));
    res.setHeader('Set-Cookie', 'gl_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    return { ok: true };
  });

  /* ---------------- me / dashboard ---------------- */

  add('GET', '/api/me', (req, res, body, { user, ws }) => ({
    sandbox: !!sandbox,
    user: { name: user.name, email: user.email, theme: user.theme || 'system' }, workspace: { name: ws.name, plan: ws.plan, timezone: ws.timezone },
    griddy_ai: !!ai.apiKey, role: user.role,
    plan: plans.status(db, ws), billing_ready: !!(stripe && stripe.configured) || !!sandbox,
    compliance_problems: C.workspaceProblems(ws),
    counts: {
      replies: db.get(`SELECT COUNT(*) n FROM messages WHERE workspace_id = ? AND direction = 'in' AND is_read = 0 AND label NOT IN ('ooo','bounce')`, ws.id).n,
      calls: db.get(`SELECT COUNT(*) n FROM tasks WHERE workspace_id = ? AND status = 'open' AND due_day <= ?`, ws.id, U.dayKey(Date.now(), ws.timezone)).n
    }
  }));

  add('PUT', '/api/me/display', (req, res, body, { user }) => {
    const theme = ['light', 'dark', 'system'].includes(body.theme) ? body.theme : 'system';
    db.run('UPDATE users SET theme = ? WHERE id = ?', theme, user.id);
    return { theme };
  });

  /* ---------------- Griddy helper ---------------- */

  const griddyUse = new Map();
  add('POST', '/api/griddy', async (req, res, body, { ws }) => {
    const history = (Array.isArray(body.messages) ? body.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-10).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    while (history.length && history[0].role !== 'user') history.shift();
    const last = history[history.length - 1];
    if (!last || last.role !== 'user') throw bad('Ask Griddy a question.');
    const facts = griddy.diagnose(db, engine, ws);
    const page = str(body.page, 40);
    if (ai.apiKey) {
      const key = ws.id + ':' + U.dayKey(Date.now(), ws.timezone);
      const used = griddyUse.get(key) || 0;
      if (used < Math.min(ai.dailyLimit || 40, plans.PLANS[plans.status(db, ws).plan].griddyAiPerDay)) {
        try {
          const answer = await griddy.aiAnswer({ apiKey: ai.apiKey, model: ai.model, ws, facts, page, history, fetchImpl: ai.fetch });
          if (answer) { griddyUse.set(key, used + 1); return { answer, source: 'ai' }; }
        } catch (e) { console.error('[griddy]', e.message); }
      }
    }
    return { answer: griddy.localAnswer(last.content, facts), source: 'guide' };
  });

  add('GET', '/api/dashboard', (req, res, body, { ws }) => {
    const now = Date.now();
    const today = U.dayKey(now, ws.timezone);
    const inboxes = db.all('SELECT * FROM inboxes WHERE workspace_id = ?', ws.id).map(inboxPublic);
    const sentToday = inboxes.reduce((s, i) => s + i.sent_today, 0);
    const limitToday = inboxes.filter((i) => i.status === 'active').reduce((s, i) => s + i.limit_today, 0);
    const since = now - 30 * 86400000;
    const contacted = db.get(`SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE workspace_id = ? AND direction = 'out' AND step_position IS NOT NULL AND created_at > ?`, ws.id, since).n;
    const replied = db.get(`SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE workspace_id = ? AND direction = 'in' AND label NOT IN ('ooo','bounce') AND created_at > ?`, ws.id, since).n;
    const bounced = db.get(`SELECT COUNT(DISTINCT lead_id) n FROM messages WHERE workspace_id = ? AND label = 'bounce' AND created_at > ?`, ws.id, since).n;
    const interested = db.get(`SELECT COUNT(*) n FROM leads WHERE workspace_id = ? AND status = 'interested' AND last_activity_at > ?`, ws.id, now - 7 * 86400000).n;
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const k = U.dayKey(now - i * 86400000, ws.timezone);
      days.push({ day: k, sent: 0, replies: 0 });
    }
    const idx = Object.fromEntries(days.map((d, i) => [d.day, i]));
    for (const m of db.all(`SELECT direction, label, created_at FROM messages WHERE workspace_id = ? AND created_at > ? AND (direction = 'out' AND step_position IS NOT NULL OR direction = 'in' AND label NOT IN ('ooo','bounce'))`, ws.id, now - 15 * 86400000)) {
      const i = idx[U.dayKey(m.created_at, ws.timezone)];
      if (i === undefined) continue;
      if (m.direction === 'out') days[i].sent++; else days[i].replies++;
    }
    const calls = db.all(`SELECT t.id, t.reason, l.first_name, l.last_name, l.company, l.title, l.phone, l.status FROM tasks t JOIN leads l ON l.id = t.lead_id
                          WHERE t.workspace_id = ? AND t.status = 'open' AND t.due_day <= ? ORDER BY CASE l.status WHEN 'interested' THEN 0 WHEN 'replied' THEN 1 ELSE 2 END, t.due_day LIMIT 6`, ws.id, today);
    const callsTotal = db.get(`SELECT COUNT(*) n FROM tasks WHERE workspace_id = ? AND status = 'open' AND due_day <= ?`, ws.id, today).n;
    const blocked = db.get(`SELECT COUNT(*) n FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE c.workspace_id = ? AND e.status = 'blocked'`, ws.id).n;
    const personalHeld = db.get(`SELECT COUNT(*) n FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE c.workspace_id = ? AND e.status = 'blocked' AND e.note LIKE 'Personal email%'`, ws.id).n;
    const suppressed = db.get('SELECT COUNT(*) n FROM suppression WHERE workspace_id = ?', ws.id).n;
    const running = db.get(`SELECT COUNT(*) n FROM campaigns WHERE workspace_id = ? AND status = 'running'`, ws.id).n;
    const recent = db.all(`SELECT m.id, m.label, m.body_text, m.created_at, l.first_name, l.last_name, l.company FROM messages m JOIN leads l ON l.id = m.lead_id
                           WHERE m.workspace_id = ? AND m.direction = 'in' AND m.label NOT IN ('ooo','bounce') ORDER BY m.created_at DESC LIMIT 4`, ws.id);
    return {
      sent_today: sentToday, limit_today: limitToday, contacted, replied, bounced, interested,
      reply_rate: contacted ? replied / contacted * 100 : 0, bounce_rate: contacted ? bounced / contacted * 100 : 0,
      days, calls, calls_total: callsTotal, inboxes, running,
      guard: { blocked, personal_held: personalHeld, suppressed, problems: C.workspaceProblems(ws) },
      recent
    };
  });

  /* ---------------- settings ---------------- */

  const WS_FIELDS = ['name', 'business_name', 'company_number', 'business_address', 'privacy_url', 'opt_out_text', 'timezone', 'adzuna_app_id', 'adzuna_app_key'];
  add('GET', '/api/settings', (req, res, body, { ws }) => {
    const out = {};
    for (const f of [...WS_FIELDS, 'retention_months', 'plan']) out[f] = ws[f];
    out.adzuna_app_key = ws.adzuna_app_key ? '••••••••' : '';
    out.problems = C.workspaceProblems(ws);
    return out;
  });
  add('PUT', '/api/settings', (req, res, body, { ws, user }) => {
    for (const f of WS_FIELDS) {
      if (body[f] === undefined) continue;
      if (f === 'adzuna_app_key' && body[f] === '••••••••') continue;
      let v = str(body[f], f === 'business_address' || f === 'opt_out_text' ? 400 : 200);
      if (f === 'privacy_url' && v && !/^https?:\/\//i.test(v)) throw bad('The privacy link must start with https://');
      if (f === 'timezone') { try { new Intl.DateTimeFormat('en-GB', { timeZone: v }); } catch (e) { throw bad('Unknown time zone.'); } }
      db.run(`UPDATE workspaces SET ${f} = ? WHERE id = ?`, v, ws.id);
    }
    if (body.retention_months !== undefined) db.run('UPDATE workspaces SET retention_months = ? WHERE id = ?', int(body.retention_months, 0, 60, 12), ws.id);
    db.audit(ws.id, user.email, 'settings_changed', '', '');
    return { ok: true, problems: C.workspaceProblems(wsFor(user)) };
  });

  /* ---------------- inboxes ---------------- */

  const PRESETS = {
    gmail: { smtp_host: 'smtp.gmail.com', smtp_port: 465, imap_host: 'imap.gmail.com', imap_port: 993 },
    zoho: { smtp_host: 'smtp.zoho.eu', smtp_port: 465, imap_host: 'imap.zoho.eu', imap_port: 993 },
    fastmail: { smtp_host: 'smtp.fastmail.com', smtp_port: 465, imap_host: 'imap.fastmail.com', imap_port: 993 }
  };

  add('GET', '/api/inboxes', (req, res, body, { ws }) => db.all('SELECT * FROM inboxes WHERE workspace_id = ? ORDER BY id', ws.id).map(inboxPublic));

  async function checkInbox(cfg, pass) {
    if (transport && transport.verify) return transport.verify(cfg, pass);
    await smtp.verify({ host: cfg.smtp_host, port: cfg.smtp_port, user: cfg.username, pass });
    await imap.verify({ host: cfg.imap_host, port: cfg.imap_port, user: cfg.username, pass });
  }

  add('POST', '/api/inboxes', async (req, res, body, { ws, user }) => {
    plans.check(db, ws, 'inbox');
    const preset = PRESETS[body.provider] || {};
    const cfg = {
      email: U.normEmail(body.email), from_name: str(body.from_name, 100), signature: str(body.signature, 1000),
      smtp_host: str(body.smtp_host || preset.smtp_host, 200), smtp_port: int(body.smtp_port || preset.smtp_port, 1, 65535, 465),
      imap_host: str(body.imap_host || preset.imap_host, 200), imap_port: int(body.imap_port || preset.imap_port, 1, 65535, 993),
      username: str(body.username, 200) || U.normEmail(body.email),
      daily_limit: int(body.daily_limit, 1, 200, 30), ramp_start: int(body.ramp_start, 1, 200, 10), ramp_step: int(body.ramp_step, 0, 50, 2)
    };
    const pass = String(body.password || '').replace(/\s+/g, '');
    if (!U.isEmail(cfg.email) || !cfg.from_name) throw bad('Enter the email address and the name people will see.');
    if (!pass) throw bad('Enter the app password for this inbox.');
    if (!cfg.smtp_host || !cfg.imap_host) throw bad('Enter the server settings, or choose a provider.');
    try { await checkInbox(cfg, pass); } catch (e) { throw bad('Could not connect: ' + e.message); }
    const r = db.run(`INSERT INTO inboxes (workspace_id, email, from_name, signature, smtp_host, smtp_port, imap_host, imap_port, username, pass_enc, daily_limit, ramp_start, ramp_step, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ws.id, cfg.email, cfg.from_name, cfg.signature, cfg.smtp_host, cfg.smtp_port, cfg.imap_host, cfg.imap_port, cfg.username, U.encrypt(pass),
      cfg.daily_limit, cfg.ramp_start, cfg.ramp_step, Date.now());
    db.audit(ws.id, user.email, 'inbox_added', cfg.email, '');
    return { ok: true, id: Number(r.lastInsertRowid) };
  });

  add('PUT', '/api/inboxes/:id', (req, res, body, { ws, params }) => {
    const i = owned('inboxes', params.id, ws.id);
    db.run(`UPDATE inboxes SET from_name = ?, signature = ?, daily_limit = ?, ramp_start = ?, ramp_step = ?, status = ? WHERE id = ?`,
      str(body.from_name ?? i.from_name, 100), str(body.signature ?? i.signature, 1000), int(body.daily_limit, 1, 200, i.daily_limit),
      int(body.ramp_start, 1, 200, i.ramp_start), int(body.ramp_step, 0, 50, i.ramp_step),
      ['active', 'paused'].includes(body.status) ? body.status : i.status === 'error' ? 'error' : i.status, i.id);
    return { ok: true };
  });

  add('POST', '/api/inboxes/:id/reconnect', async (req, res, body, { ws, params }) => {
    const i = owned('inboxes', params.id, ws.id);
    const pass = body.password ? String(body.password).replace(/\s+/g, '') : U.decrypt(i.pass_enc);
    try { await checkInbox(i, pass); } catch (e) { throw bad('Still cannot connect: ' + e.message); }
    db.run(`UPDATE inboxes SET pass_enc = ?, status = 'active', last_error = '' WHERE id = ?`, U.encrypt(pass), i.id);
    return { ok: true };
  });

  add('DELETE', '/api/inboxes/:id', (req, res, body, { ws, params, user }) => {
    const i = owned('inboxes', params.id, ws.id);
    db.run('DELETE FROM inboxes WHERE id = ?', i.id);
    db.audit(ws.id, user.email, 'inbox_removed', i.email, '');
    return { ok: true };
  });

  /* ---------------- leads ---------------- */

  const LEAD_FIELDS = ['first_name', 'last_name', 'company', 'title', 'phone', 'website', 'source', 'personal_line'];

  add('GET', '/api/leads', (req, res, body, { ws, query }) => {
    const where = ['workspace_id = ?'];
    const p = [ws.id];
    if (query.status && query.status !== 'all') { where.push('status = ?'); p.push(query.status); }
    if (query.q) { where.push('(email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR company LIKE ?)'); const q = '%' + query.q + '%'; p.push(q, q, q, q); }
    const page = int(query.page, 1, 10000, 1);
    const rows = db.all(`SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 100 OFFSET ?`, ...p, (page - 1) * 100);
    const total = db.get(`SELECT COUNT(*) n FROM leads WHERE ${where.join(' AND ')}`, ...p).n;
    const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM leads WHERE workspace_id = ? GROUP BY status', ws.id).map((r) => [r.status, r.n]));
    const notes = {};
    if (rows.length) {
      for (const r of db.all(`SELECT e.lead_id, e.status, e.note, e.current_step, c.name FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id
                              WHERE e.lead_id IN (${rows.map(() => '?').join(',')}) ORDER BY e.id`, ...rows.map((r) => r.id))) {
        notes[r.lead_id] = r;
      }
    }
    return {
      total, counts, page,
      rows: rows.map((l) => ({ ...l, custom: safeJson(l.custom_json), personal: U.isPersonalEmail(l.email), enrollment: notes[l.id] || null }))
    };
  });

  add('GET', '/api/leads/:id', (req, res, body, { ws, params }) => {
    const l = owned('leads', params.id, ws.id);
    return {
      lead: { ...l, custom: safeJson(l.custom_json), personal: U.isPersonalEmail(l.email), suppressed: C.isSuppressed(db, ws.id, l.email) },
      messages: db.all('SELECT id, direction, subject, body_text, label, created_at, step_position FROM messages WHERE lead_id = ? ORDER BY created_at', l.id),
      enrollments: db.all('SELECT e.*, c.name FROM enrollments e JOIN campaigns c ON c.id = e.campaign_id WHERE e.lead_id = ?', l.id),
      tasks: db.all('SELECT * FROM tasks WHERE lead_id = ? ORDER BY created_at DESC', l.id)
    };
  });

  function insertLead(wsId, d) {
    const email = U.normEmail(d.email);
    if (!U.isEmail(email)) return { skipped: 'invalid' };
    if (db.get('SELECT 1 FROM leads WHERE workspace_id = ? AND email = ?', wsId, email)) return { skipped: 'duplicate' };
    const r = db.run(`INSERT INTO leads (workspace_id, email, first_name, last_name, company, title, phone, website, source, personal_line, custom_json, consent, unsubscribe_token, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      wsId, email, str(d.first_name, 100), str(d.last_name, 100), str(d.company, 200), str(d.title, 200), str(d.phone, 50), str(d.website, 200),
      str(d.source, 300), str(d.personal_line, 500), JSON.stringify(d.custom || {}), d.consent ? 1 : 0, U.randomToken(18), Date.now());
    return { id: Number(r.lastInsertRowid) };
  }

  add('POST', '/api/leads', (req, res, body, { ws, user }) => {
    plans.check(db, ws, 'lead');
    const r = insertLead(ws.id, body);
    if (r.skipped === 'invalid') throw bad('Enter a valid email address.');
    if (r.skipped === 'duplicate') throw bad('That email address is already in your leads.');
    db.audit(ws.id, user.email, 'lead_added', U.normEmail(body.email), body.source || '');
    return { ok: true, id: r.id };
  });

  add('POST', '/api/leads/import', (req, res, body, { ws, user }) => {
    const rows = U.parseCsv(String(body.csv || ''));
    if (rows.length < 2) throw bad('The file needs a header row and at least one contact.');
    const header = rows[0].map((h) => h.trim());
    const mapping = body.mapping || {};
    const col = (f) => (mapping[f] !== undefined && mapping[f] !== '' ? header.indexOf(mapping[f]) : -1);
    if (col('email') === -1) throw bad('Choose which column holds the email address.');
    const known = new Set(Object.values(mapping).filter(Boolean));
    const defaultSource = str(body.source, 300);
    let added = 0, duplicates = 0, invalid = 0, overLimit = 0;
    let room = plans.leadRoom(db, ws);
    if (room <= 0) plans.check(db, ws, 'lead');
    db.tx(() => {
      for (const r of rows.slice(1)) {
        const d = { custom: {} };
        for (const f of ['email', ...LEAD_FIELDS]) { const i = col(f); if (i > -1) d[f] = r[i] || ''; }
        header.forEach((h, i) => { if (!known.has(h) && h) d.custom[h] = r[i] || ''; });
        if (!d.source) d.source = defaultSource;
        d.consent = !!body.consent;
        if (room <= 0) { overLimit++; continue; }
        const res2 = insertLead(ws.id, d);
        if (res2.id) room--;
        if (res2.id) added++; else if (res2.skipped === 'duplicate') duplicates++; else invalid++;
      }
    });
    db.audit(ws.id, user.email, 'leads_imported', '', `${added} added, ${duplicates} duplicates, ${invalid} invalid. Source: ${defaultSource || 'per row'}`);
    return { added, duplicates, invalid, over_limit: overLimit, limit_note: overLimit ? `${overLimit} not added: your plan's lead limit was reached.` : '' };
  });

  add('PUT', '/api/leads/:id', (req, res, body, { ws, params, user }) => {
    const l = owned('leads', params.id, ws.id);
    for (const f of LEAD_FIELDS) if (body[f] !== undefined) db.run(`UPDATE leads SET ${f} = ? WHERE id = ?`, str(body[f], f === 'personal_line' ? 500 : 300), l.id);
    if (body.consent !== undefined) {
      db.run('UPDATE leads SET consent = ? WHERE id = ?', body.consent ? 1 : 0, l.id);
      db.audit(ws.id, user.email, body.consent ? 'consent_recorded' : 'consent_removed', l.email, '');
    }
    // A fixed lead can be retried.
    db.run(`UPDATE enrollments SET status = 'queued', note = '' WHERE lead_id = ? AND status = 'blocked'`, l.id);
    return { ok: true };
  });

  add('POST', '/api/leads/:id/forget', (req, res, body, { ws, params, user }) => {
    const l = owned('leads', params.id, ws.id);
    db.tx(() => {
      C.suppress(db, ws.id, l.email, 'Erasure request: never contact again', user.email);
      db.run('DELETE FROM leads WHERE id = ?', l.id);
    });
    db.audit(ws.id, user.email, 'lead_erased', l.email, 'All personal data deleted; email kept only on Do Not Contact list');
    return { ok: true };
  });

  add('DELETE', '/api/leads/:id', (req, res, body, { ws, params, user }) => {
    const l = owned('leads', params.id, ws.id);
    db.run('DELETE FROM leads WHERE id = ?', l.id);
    db.audit(ws.id, user.email, 'lead_deleted', l.email, '');
    return { ok: true };
  });

  /* ---------------- campaigns ---------------- */

  add('GET', '/api/campaigns', (req, res, body, { ws }) =>
    db.all('SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY id DESC', ws.id).map(campaignDetail));

  add('POST', '/api/campaigns', (req, res, body, { ws, user }) => {
    const name = str(body.name, 120) || 'New campaign';
    const id = db.tx(() => {
      const r = db.run('INSERT INTO campaigns (workspace_id, name, created_at) VALUES (?,?,?)', ws.id, name, Date.now());
      const cid = Number(r.lastInsertRowid);
      const def = [
        ['email', 0, 'Quick question, {{FirstName}}', 'Hi {{FirstName}},\n\n{{PersonalLine}}\n\n[One or two lines on how you help businesses like {{Company}}.]\n\nWould it be worth a quick chat this week?\n\nThanks,\n{{SenderFirstName}}'],
        ['call', 3, '', 'Hi {{FirstName}}, it\'s {{SenderFirstName}}. I emailed you on Monday about [topic]. Did it reach you?\n\n[If yes] Is that something you could use?\n[If no] No problem. Is [the problem you solve] something you\'re dealing with at the moment?'],
        ['email', 1, '', 'Hi {{FirstName}},\n\nJust checking my last email reached you. Happy to send over a few details if it would help.\n\nThanks,\n{{SenderFirstName}}'],
        ['email', 7, '', "Hi {{FirstName}},\n\nI won't keep filling your inbox. If it's ever useful, just reply here.\n\nAll the best,\n{{SenderFirstName}}"]
      ];
      def.forEach((s, i) => db.run('INSERT INTO steps (campaign_id, position, type, delay_days, subject, body) VALUES (?,?,?,?,?,?)', cid, i + 1, s[0], s[1], s[2], s[3]));
      for (const i of db.all(`SELECT id FROM inboxes WHERE workspace_id = ? AND status = 'active'`, ws.id)) db.run('INSERT INTO campaign_inboxes VALUES (?,?)', cid, i.id);
      return cid;
    });
    db.audit(ws.id, user.email, 'campaign_created', '', name);
    return { ok: true, id };
  });

  add('GET', '/api/campaigns/:id', (req, res, body, { ws, params }) => {
    const c = owned('campaigns', params.id, ws.id);
    const d = campaignDetail(c);
    d.problems = [...C.workspaceProblems(ws), ...C.campaignProblems(c, d.steps, d.inbox_ids)];
    d.enrollments = db.all(`SELECT e.id, e.status, e.current_step, e.note, e.next_due_at, l.id lead_id, l.first_name, l.last_name, l.email, l.company, l.status lead_status
                            FROM enrollments e JOIN leads l ON l.id = e.lead_id WHERE e.campaign_id = ? ORDER BY e.id DESC LIMIT 300`, c.id);
    // Pre-flight safety check so problems show up before sending day.
    const firstEmail = d.steps.find((s) => s.type === 'email');
    const anyInbox = db.get(`SELECT i.* FROM inboxes i JOIN campaign_inboxes ci ON ci.inbox_id = i.id WHERE ci.campaign_id = ? LIMIT 1`, c.id);
    d.will_hold = 0;
    for (const e of d.enrollments) {
      if (e.status !== 'queued') continue;
      const lead = db.get('SELECT * FROM leads WHERE id = ?', e.lead_id);
      let why = C.leadBlockReason(db, ws, lead);
      if (!why && firstEmail) {
        const r = renderEmail({ ws, lead, inbox: anyInbox || { from_name: 'You', email: '', signature: '' }, step: firstEmail, firstEmail: true, unsubscribeUrl: '' });
        if (r.errors.length) why = 'Email would not send: ' + r.errors.join('; ');
      }
      if (why) { e.note = 'Will be held: ' + why; e.warn = true; d.will_hold++; }
    }
    return d;
  });

  add('PUT', '/api/campaigns/:id', (req, res, body, { ws, params }) => {
    const c = owned('campaigns', params.id, ws.id);
    db.tx(() => {
      const days = Array.isArray(body.days) ? body.days.map(Number).filter((d) => d >= 1 && d <= 7).join(',') : c.days;
      db.run(`UPDATE campaigns SET name = ?, days = ?, start_hour = ?, end_hour = ?, one_per_company = ?, lia_purpose = ?, lia_relevance = ?, lia_balance = ? WHERE id = ?`,
        str(body.name ?? c.name, 120) || c.name, days, int(body.start_hour, 0, 23, c.start_hour), int(body.end_hour, 1, 24, c.end_hour),
        body.one_per_company === undefined ? c.one_per_company : body.one_per_company ? 1 : 0,
        str(body.lia_purpose ?? c.lia_purpose, 1000), str(body.lia_relevance ?? c.lia_relevance, 1000), str(body.lia_balance ?? c.lia_balance, 1000), c.id);
      if (Array.isArray(body.steps)) {
        if (body.steps.length > 12) throw bad('A campaign can have up to 12 steps.');
        db.run('DELETE FROM steps WHERE campaign_id = ?', c.id);
        body.steps.forEach((s, i) => db.run('INSERT INTO steps (campaign_id, position, type, delay_days, subject, body) VALUES (?,?,?,?,?,?)',
          c.id, i + 1, s.type === 'call' ? 'call' : 'email', i === 0 ? 0 : int(s.delay_days, 0, 60, 2), str(s.subject, 200), str(s.body, 10000)));
      }
      if (Array.isArray(body.inbox_ids)) {
        db.run('DELETE FROM campaign_inboxes WHERE campaign_id = ?', c.id);
        for (const id of body.inbox_ids) { const i = db.get('SELECT id FROM inboxes WHERE id = ? AND workspace_id = ?', Number(id), ws.id); if (i) db.run('INSERT INTO campaign_inboxes VALUES (?,?)', c.id, i.id); }
      }
    });
    return { ok: true };
  });

  add('POST', '/api/campaigns/:id/leads', (req, res, body, { ws, params, user }) => {
    const c = owned('campaigns', params.id, ws.id);
    let ids = [];
    if (Array.isArray(body.lead_ids)) ids = body.lead_ids.map(Number);
    else if (body.status) ids = db.all('SELECT id FROM leads WHERE workspace_id = ? AND status = ?', ws.id, String(body.status)).map((r) => r.id);
    let added = 0;
    db.tx(() => {
      for (const id of ids) {
        const l = db.get('SELECT id FROM leads WHERE id = ? AND workspace_id = ?', id, ws.id);
        if (!l) continue;
        const r = db.run(`INSERT OR IGNORE INTO enrollments (campaign_id, lead_id, status, next_due_at, created_at) VALUES (?,?, 'queued', ?, ?)`, c.id, l.id, Date.now(), Date.now());
        added += Number(r.changes || 0);
      }
    });
    db.audit(ws.id, user.email, 'leads_added_to_campaign', '', `${added} → ${c.name}`);
    return { added };
  });

  add('DELETE', '/api/campaigns/:id/leads/:eid', (req, res, body, { ws, params }) => {
    const c = owned('campaigns', params.id, ws.id);
    db.run('DELETE FROM enrollments WHERE id = ? AND campaign_id = ?', Number(params.eid), c.id);
    return { ok: true };
  });

  add('POST', '/api/campaigns/:id/launch', (req, res, body, { ws, params, user }) => {
    const c = owned('campaigns', params.id, ws.id);
    const d = campaignDetail(c);
    const problems = [...C.workspaceProblems(ws), ...C.campaignProblems(c, d.steps, d.inbox_ids)];
    if (problems.length) throw bad(problems.join(' '));
    if (!db.get(`SELECT 1 FROM enrollments WHERE campaign_id = ? AND status IN ('queued','active')`, c.id)) throw bad('Add some leads to the campaign first.');
    plans.check(db, ws, 'send');
    db.run(`UPDATE campaigns SET status = 'running', launched_at = COALESCE(launched_at, ?) WHERE id = ?`, Date.now(), c.id);
    db.audit(ws.id, user.email, 'campaign_launched', '', `${c.name}. Legitimate interest: ${c.lia_purpose} | ${c.lia_relevance} | ${c.lia_balance}`);
    return { ok: true };
  });

  add('POST', '/api/campaigns/:id/pause', (req, res, body, { ws, params, user }) => {
    const c = owned('campaigns', params.id, ws.id);
    db.run(`UPDATE campaigns SET status = 'paused' WHERE id = ?`, c.id);
    db.audit(ws.id, user.email, 'campaign_paused', '', c.name);
    return { ok: true };
  });

  add('DELETE', '/api/campaigns/:id', (req, res, body, { ws, params, user }) => {
    const c = owned('campaigns', params.id, ws.id);
    db.run('DELETE FROM campaigns WHERE id = ?', c.id);
    db.audit(ws.id, user.email, 'campaign_deleted', '', c.name);
    return { ok: true };
  });

  add('POST', '/api/campaigns/:id/preview', (req, res, body, { ws, params }) => {
    const c = owned('campaigns', params.id, ws.id);
    const steps = Array.isArray(body.steps) ? body.steps.map((s, i) => ({ ...s, position: i + 1 })) : db.all('SELECT * FROM steps WHERE campaign_id = ? ORDER BY position', c.id);
    let lead = body.lead_id ? db.get('SELECT * FROM leads WHERE id = ? AND workspace_id = ?', Number(body.lead_id), ws.id) : null;
    if (!lead) lead = db.get(`SELECT l.* FROM leads l JOIN enrollments e ON e.lead_id = l.id WHERE e.campaign_id = ? ORDER BY e.id LIMIT 1`, c.id);
    if (!lead) lead = { email: 'jo.bloggs@example.co.uk', first_name: 'Jo', last_name: 'Bloggs', company: 'Example Ltd', title: 'Operations Manager', source: 'Example Ltd website', personal_line: 'I saw you\'re opening a new site in Stafford.', custom_json: '{}', unsubscribe_token: 'example' };
    const inbox = db.get(`SELECT i.* FROM inboxes i JOIN campaign_inboxes ci ON ci.inbox_id = i.id WHERE ci.campaign_id = ? LIMIT 1`, c.id) ||
      { from_name: wsFor({ workspace_id: ws.id }).business_name || 'You', email: 'you@yourcompany.co.uk', signature: '' };
    let firstSubject = '';
    let emailCount = 0;
    const out = steps.map((s) => {
      if (s.type === 'call') return { type: 'call', script: renderScript(s, lead, inbox) };
      const r = renderEmail({ ws, lead, inbox, step: s, firstEmail: emailCount++ === 0, unsubscribeUrl: appUrl ? appUrl + '/u/…' : '' });
      if (!firstSubject) firstSubject = r.subject;
      return { type: 'email', subject: r.subject || 'Re: ' + firstSubject, text: r.text, errors: r.errors };
    });
    return { lead: { name: `${lead.first_name} ${lead.last_name}`.trim(), email: lead.email }, steps: out };
  });

  add('POST', '/api/campaigns/:id/test', async (req, res, body, { ws, params, user }) => {
    const c = owned('campaigns', params.id, ws.id);
    const steps = db.all(`SELECT * FROM steps WHERE campaign_id = ? AND type = 'email' ORDER BY position`, c.id);
    const inbox = db.get(`SELECT i.* FROM inboxes i JOIN campaign_inboxes ci ON ci.inbox_id = i.id WHERE ci.campaign_id = ? AND i.status = 'active' LIMIT 1`, c.id);
    if (!inbox) throw bad('Connect an inbox and add it to this campaign first.');
    const lead = db.get(`SELECT l.* FROM leads l JOIN enrollments e ON e.lead_id = l.id WHERE e.campaign_id = ? ORDER BY e.id LIMIT 1`, c.id) ||
      { email: user.email, first_name: user.name.split(' ')[0], last_name: '', company: ws.business_name || 'Your Company', title: '', source: 'test', personal_line: '', custom_json: '{}' };
    let n = 0;
    for (const s of steps) {
      const r = renderEmail({ ws, lead, inbox, step: s, firstEmail: n === 0, unsubscribeUrl: appUrl ? appUrl + '/u/test' : '' });
      if (r.errors.length) throw bad(`Step ${s.position}: ${r.errors.join('; ')}`);
      const raw = buildMessage({ fromName: inbox.from_name, fromEmail: inbox.email, to: user.email, subject: `[TEST ${s.position}] ${r.subject || '(follow-up in same thread)'}`, text: r.text, html: r.html, messageId: newMessageId(inbox.email) });
      if (sendTest) await sendTest(inbox, { to: user.email, raw });
      else await smtp.sendMail({ host: inbox.smtp_host, port: inbox.smtp_port, user: inbox.username, pass: U.decrypt(inbox.pass_enc), from: inbox.email, to: user.email, raw });
      n++;
    }
    return { sent: n, to: user.email };
  });

  /* ---------------- calls ---------------- */

  add('GET', '/api/tasks', (req, res, body, { ws, query }) => {
    const today = U.dayKey(Date.now(), ws.timezone);
    const done = query.view === 'done';
    const rows = db.all(`SELECT t.*, l.first_name, l.last_name, l.company, l.title, l.phone, l.email, l.status lead_status, c.name campaign_name
                         FROM tasks t JOIN leads l ON l.id = t.lead_id LEFT JOIN campaigns c ON c.id = t.campaign_id
                         WHERE t.workspace_id = ? AND ${done ? "t.status = 'done'" : "t.status = 'open' AND t.due_day <= ?"}
                         ORDER BY ${done ? 't.completed_at DESC' : "CASE l.status WHEN 'interested' THEN 0 WHEN 'replied' THEN 1 ELSE 2 END, t.due_day"} LIMIT 200`,
      ...(done ? [ws.id] : [ws.id, today]));
    const upcoming = done ? 0 : db.get(`SELECT COUNT(*) n FROM tasks WHERE workspace_id = ? AND status = 'open' AND due_day > ?`, ws.id, today).n;
    return { rows, upcoming, today };
  });

  add('POST', '/api/tasks/:id/outcome', (req, res, body, { ws, params, user }) => {
    const allowed = ['no_answer', 'voicemail', 'interested', 'not_now', 'wrong_person', 'do_not_contact', 'done'];
    if (!allowed.includes(body.outcome)) throw bad('Pick an outcome.');
    engine.callOutcome(ws.id, Number(params.id), body.outcome, str(body.notes, 1000), user.email);
    return { ok: true };
  });

  /* ---------------- replies ---------------- */

  add('GET', '/api/replies', (req, res, body, { ws, query }) => {
    const label = query.label && query.label !== 'all' ? String(query.label) : null;
    const rows = db.all(`SELECT m.*, l.first_name, l.last_name, l.company, l.title, l.phone, l.email lead_email, l.status lead_status
                         FROM messages m JOIN leads l ON l.id = m.lead_id
                         WHERE m.workspace_id = ? AND m.direction = 'in' AND m.label NOT IN ('bounce') ${label ? 'AND m.label = ?' : "AND m.label != 'ooo'"}
                         ORDER BY m.created_at DESC LIMIT 200`, ...(label ? [ws.id, label] : [ws.id]));
    for (const r of rows) {
      r.thread = db.all(`SELECT id, direction, subject, body_text, created_at FROM messages WHERE lead_id = ? AND label != 'bounce' ORDER BY created_at`, r.lead_id);
    }
    const counts = Object.fromEntries(db.all(`SELECT label, COUNT(*) n FROM messages WHERE workspace_id = ? AND direction = 'in' AND is_read = 0 GROUP BY label`, ws.id).map((r) => [r.label, r.n]));
    return { rows, counts };
  });

  add('POST', '/api/replies/:id/read', (req, res, body, { ws, params }) => {
    const m = owned('messages', params.id, ws.id);
    db.run('UPDATE messages SET is_read = 1 WHERE id = ?', m.id);
    return { ok: true };
  });

  add('POST', '/api/replies/:id/label', (req, res, body, { ws, params, user }) => {
    const m = owned('messages', params.id, ws.id);
    const label = String(body.label || '');
    if (!['interested', 'question', 'not_interested', 'opted_out', 'other'].includes(label)) throw bad('Unknown label.');
    db.run('UPDATE messages SET label = ? WHERE id = ?', label, m.id);
    const leadStatus = { interested: 'interested', not_interested: 'not_interested', opted_out: 'opted_out', question: 'replied', other: 'replied' }[label];
    db.run('UPDATE leads SET status = ? WHERE id = ?', leadStatus, m.lead_id);
    if (label === 'opted_out') {
      const l = db.get('SELECT email FROM leads WHERE id = ?', m.lead_id);
      C.suppress(db, ws.id, l.email, 'Opted out (marked by user)', user.email);
      engine.stopLead(ws.id, m.lead_id, 'stopped', 'Opted out');
    }
    return { ok: true };
  });

  add('POST', '/api/replies/:id/reply', async (req, res, body, { ws, params, user }) => {
    const m = owned('messages', params.id, ws.id);
    const text = str(body.body, 10000);
    if (!text) throw bad('Write your reply first.');
    const inbox = db.get('SELECT * FROM inboxes WHERE id = ? AND workspace_id = ?', m.inbox_id, ws.id);
    if (!inbox) throw bad('The inbox this reply came into is no longer connected.');
    const lead = db.get('SELECT * FROM leads WHERE id = ?', m.lead_id);
    const subject = 'Re: ' + String(m.subject || '').replace(/^re:\s*/i, '');
    const mid = newMessageId(inbox.email);
    const html = '<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55">' + text.split(/\n{2,}/).map((p) => '<p>' + U.escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('') +
      (inbox.signature ? '<p>' + U.escapeHtml(inbox.signature).replace(/\n/g, '<br>') + '</p>' : '') + '</div>';
    const raw = buildMessage({ fromName: inbox.from_name, fromEmail: inbox.email, to: lead.email, subject, text: text + (inbox.signature ? '\n\n' + inbox.signature : ''), html, messageId: mid, inReplyTo: m.message_id, references: m.message_id });
    if (sendTest) await sendTest(inbox, { to: lead.email, raw });
    else await smtp.sendMail({ host: inbox.smtp_host, port: inbox.smtp_port, user: inbox.username, pass: U.decrypt(inbox.pass_enc), from: inbox.email, to: lead.email, raw });
    db.run(`INSERT INTO messages (workspace_id, enrollment_id, lead_id, inbox_id, direction, message_id, in_reply_to, subject, body_text, from_email, to_email, is_read, created_at)
            VALUES (?,?,?,?, 'out', ?,?,?,?,?,?, 1, ?)`, ws.id, m.enrollment_id, lead.id, inbox.id, mid, m.message_id, subject, text, inbox.email, lead.email, Date.now());
    db.run('UPDATE messages SET is_read = 1 WHERE id = ?', m.id);
    db.audit(ws.id, user.email, 'reply_sent', lead.email, subject);
    return { ok: true };
  });

  /* ---------------- do not contact + audit ---------------- */

  add('GET', '/api/suppression', (req, res, body, { ws }) => db.all('SELECT * FROM suppression WHERE workspace_id = ? ORDER BY id DESC LIMIT 1000', ws.id));
  add('POST', '/api/suppression', (req, res, body, { ws, user }) => {
    const lines = String(body.values || '').split(/[\s,;]+/).map((v) => v.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
    let n = 0;
    for (const v of lines) {
      if (!U.isEmail(v) && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) continue;
      C.suppress(db, ws.id, v, str(body.reason, 200) || 'Added manually', user.email);
      const l = db.get('SELECT id FROM leads WHERE workspace_id = ? AND email = ?', ws.id, v);
      if (l) engine.stopLead(ws.id, l.id, 'stopped', 'Added to Do Not Contact');
      n++;
    }
    return { added: n };
  });
  add('DELETE', '/api/suppression/:id', (req, res, body, { ws, params, user }) => {
    const s = owned('suppression', params.id, ws.id);
    if (/erasure|unsubscribed|asked/i.test(s.reason)) throw bad('This person asked not to be contacted, so they stay on the list.');
    db.run('DELETE FROM suppression WHERE id = ?', s.id);
    db.audit(ws.id, user.email, 'unsuppressed', s.value, '');
    return { ok: true };
  });

  add('GET', '/api/audit', (req, res, body, { ws }) => db.all('SELECT * FROM audit WHERE workspace_id = ? ORDER BY id DESC LIMIT 200', ws.id));
  add('GET', '/api/audit.csv', (req, res, body, { ws }) => {
    const rows = db.all('SELECT at, actor, action, email, detail FROM audit WHERE workspace_id = ? ORDER BY id', ws.id);
    const csv = U.toCsv([['Time (UTC)', 'By', 'Action', 'Email', 'Detail'], ...rows.map((r) => [new Date(r.at).toISOString(), r.actor, r.action, r.email, r.detail])]);
    return { __raw: csv, type: 'text/csv; charset=utf-8', filename: 'gridline-audit-log.csv' };
  });

  /* ---------------- growth signals ---------------- */

  add('GET', '/api/signals', (req, res, body, { ws }) => {
    const rows = db.all(`SELECT * FROM signals WHERE workspace_id = ? AND status != 'dismissed' ORDER BY posted_at DESC, id DESC LIMIT 300`, ws.id);
    const byCompany = {};
    for (const s of rows) (byCompany[s.company] = byCompany[s.company] || []).push(s);
    const leadsByCompany = new Set(db.all('SELECT DISTINCT LOWER(company) c FROM leads WHERE workspace_id = ?', ws.id).map((r) => r.c));
    return {
      configured: !!(ws.adzuna_app_id && ws.adzuna_app_key),
      companies: Object.entries(byCompany).map(([company, jobs]) => ({ company, jobs, has_lead: leadsByCompany.has(company.toLowerCase()) }))
    };
  });
  add('POST', '/api/signals/search', async (req, res, body, { ws }) => {
    const what = str(body.what, 100);
    if (!what) throw bad('Enter job titles or keywords to search for.');
    const jobs = await signals.searchJobs(ws, { what, where: str(body.where, 100), days: int(body.days, 1, 60, 14), fetchImpl: transport && transport.fetchJobs });
    return { found: jobs.length, added: signals.saveSignals(db, ws.id, jobs) };
  });
  add('POST', '/api/signals/:id/dismiss', (req, res, body, { ws, params }) => {
    const s = owned('signals', params.id, ws.id);
    db.run(`UPDATE signals SET status = 'dismissed' WHERE workspace_id = ? AND company = ?`, ws.id, s.company);
    return { ok: true };
  });
  add('POST', '/api/signals/:id/lead', (req, res, body, { ws, params, user }) => {
    plans.check(db, ws, 'lead');
    const s = owned('signals', params.id, ws.id);
    const extra = signals.leadFromSignal(s);
    const r = insertLead(ws.id, { ...body, company: s.company, personal_line: body.personal_line || extra.personal_line, source: extra.source });
    if (r.skipped === 'invalid') throw bad('Enter a valid work email address.');
    if (r.skipped === 'duplicate') throw bad('That person is already in your leads.');
    db.run(`UPDATE signals SET status = 'saved' WHERE id = ?`, s.id);
    db.audit(ws.id, user.email, 'lead_added', U.normEmail(body.email), extra.source);
    return { ok: true, id: r.id };
  });

  /* ---------------- engine ---------------- */

  add('POST', '/api/engine/run', async (req, res, body, { ws }) => {
    await engine.pollInboxes(true);
    await engine.processDue();
    return { ok: true };
  });

  /* ---------------- first-run content ---------------- */

  /* ---------------- team ---------------- */

  const ownerOnly = (user) => { if (user.role !== 'owner') throw new HttpError(403, 'Only the account owner can do that.'); };

  add('GET', '/api/team', (req, res, body, { ws }) => ({
    users: db.all('SELECT id, name, email, role, created_at FROM users WHERE workspace_id = ? ORDER BY created_at', ws.id),
    invites: db.all('SELECT id, email, created_at, expires_at FROM invites WHERE workspace_id = ? AND expires_at > ? ORDER BY created_at DESC', ws.id, Date.now()),
    plan: plans.status(db, ws)
  }));
  add('POST', '/api/team/invite', (req, res, body, { ws, user }) => {
    ownerOnly(user);
    const email = U.normEmail(body.email);
    if (!U.isEmail(email)) throw bad('Enter a valid email address.');
    if (db.get('SELECT 1 FROM users WHERE email = ?', email)) throw bad('That person already has a Gridline.io account.');
    db.run('DELETE FROM invites WHERE workspace_id = ? AND email = ?', ws.id, email);
    plans.check(db, ws, 'user');
    const token = U.randomToken(24);
    db.run('INSERT INTO invites (workspace_id, email, token_hash, invited_by, expires_at, created_at) VALUES (?,?,?,?,?,?)', ws.id, email, U.sha256(token), user.email, Date.now() + 7 * plans.DAY, Date.now());
    db.audit(ws.id, user.email, 'user_invited', email, '');
    return { link: `${appUrl || ''}/#/join/${token}` };
  });
  add('DELETE', '/api/team/invites/:id', (req, res, body, { ws, user, params }) => {
    ownerOnly(user); db.run('DELETE FROM invites WHERE id = ? AND workspace_id = ?', Number(params.id), ws.id); return { ok: true };
  });
  add('DELETE', '/api/team/users/:id', (req, res, body, { ws, user, params }) => {
    ownerOnly(user);
    const u = owned('users', params.id, ws.id);
    if (u.role === 'owner') throw bad("The account owner can't be removed.");
    db.run('DELETE FROM users WHERE id = ?', u.id);
    db.audit(ws.id, user.email, 'user_removed', u.email, '');
    return { ok: true };
  });
  add('GET', '/api/join/:token', (req, res, body, { params }) => {
    const inv = db.get('SELECT i.email, w.name FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_hash = ? AND i.expires_at > ?', U.sha256(params.token), Date.now());
    if (!inv) throw new HttpError(404, 'This invite has expired or already been used. Ask for a new one.');
    return { email: inv.email, workspace: inv.name };
  }, { auth: false });
  add('POST', '/api/join/:token', (req, res, body, { params }) => {
    const inv = db.get('SELECT * FROM invites WHERE token_hash = ? AND expires_at > ?', U.sha256(params.token), Date.now());
    if (!inv) throw new HttpError(404, 'This invite has expired or already been used. Ask for a new one.');
    const name = str(body.name, 100), password = String(body.password || '');
    if (!name) throw bad('Enter your name.');
    if (password.length < 10) throw bad('Use a password of at least 10 characters.');
    if (db.get('SELECT 1 FROM users WHERE email = ?', inv.email)) throw bad('An account with that email already exists. Log in instead.');
    const userId = db.tx(() => {
      db.run('DELETE FROM invites WHERE id = ?', inv.id);
      const u = db.run("INSERT INTO users (workspace_id, email, name, pass_hash, role, created_at) VALUES (?,?,?,?, 'member', ?)", inv.workspace_id, inv.email, name, U.hashPassword(password), Date.now());
      return Number(u.lastInsertRowid);
    });
    db.audit(inv.workspace_id, inv.email, 'user_joined', inv.email, '');
    makeSession(res, userId);
    return { ok: true };
  }, { auth: false });

  /* ---------------- plan & billing ---------------- */

  function applySubscription(wsId, fields) {
    db.run(`UPDATE workspaces SET plan = ?, extra_seats = ?, sub_status = ?, stripe_customer_id = COALESCE(NULLIF(?, ''), stripe_customer_id),
            stripe_subscription_id = ?, period_end = ? WHERE id = ?`,
      fields.plan, fields.extra_seats, fields.sub_status, fields.stripe_customer_id, fields.stripe_subscription_id, fields.period_end, wsId);
  }
  const billingUrl = () => appUrl || 'http://localhost:3000';

  add('GET', '/api/billing', (req, res, body, { ws }) => ({
    plan: plans.status(db, ws),
    prices: { pro: plans.PLANS.pro.price, seat: plans.PLANS.pro.seatPrice, enterprise: plans.PLANS.enterprise.price },
    limits: Object.fromEntries(Object.entries(plans.PLANS).map(([k, p]) => [k, { inboxesPerUser: Number.isFinite(p.inboxesPerUser) ? p.inboxesPerUser : null, emails: Number.isFinite(p.emails) ? p.emails : null, leads: Number.isFinite(p.leads) ? p.leads : null, days: p.days || null }])),
    ready: !!(stripe && stripe.configured), sandbox: !!sandbox
  }));
  add('POST', '/api/billing/checkout', async (req, res, body, { ws, user }) => {
    ownerOnly(user);
    const plan = body.plan === 'enterprise' ? 'enterprise' : 'pro';
    const extraSeats = plan === 'pro' ? int(body.extra_seats, 0, 50, 0) : 0;
    const st = plans.status(db, ws);
    if (st.paid && ws.stripe_subscription_id) throw bad('You already have a plan. Use "Manage billing" to change it.');
    if (stripe && stripe.configured) {
      const session = await stripe.checkout({ ws, email: user.email, plan, extraSeats, appUrl: billingUrl() });
      return { url: session.url };
    }
    if (sandbox) { // Demo only: pretend the payment went through.
      applySubscription(ws.id, { plan, extra_seats: extraSeats, sub_status: 'active', stripe_customer_id: '', stripe_subscription_id: 'sandbox', period_end: Date.now() + 30 * plans.DAY });
      db.audit(ws.id, user.email, 'plan_changed', '', `Sandbox: ${plan}, ${extraSeats} extra users`);
      return { url: '#/settings/billing?paid=1' };
    }
    throw bad("Payments aren't set up yet. (Owner: add your Stripe keys, see the launch guide.)");
  });
  add('POST', '/api/billing/seats', async (req, res, body, { ws, user }) => {
    ownerOnly(user);
    const st = plans.status(db, ws);
    if (st.plan !== 'pro') throw bad('Extra users are part of the Pro plan.');
    const extra = int(body.extra_seats, 0, 50, 0);
    if (1 + extra < st.users + st.pending_invites) throw bad(`You have ${st.users + st.pending_invites} users and invites. Remove some before lowering your seats.`);
    if (ws.stripe_subscription_id === 'sandbox' && sandbox) db.run('UPDATE workspaces SET extra_seats = ? WHERE id = ?', extra, ws.id);
    else if (stripe && stripe.configured) applySubscription(ws.id, stripe.planFromSubscription(await stripe.setSeats(ws, extra)));
    else throw bad("Payments aren't set up yet.");
    db.audit(ws.id, user.email, 'seats_changed', '', `${extra} extra users`);
    return { ok: true };
  });
  add('POST', '/api/billing/portal', async (req, res, body, { ws, user }) => {
    ownerOnly(user);
    if (ws.stripe_subscription_id === 'sandbox' && sandbox) { // Demo: "cancel" straight away.
      db.run("UPDATE workspaces SET plan = 'trial', sub_status = 'canceled', extra_seats = 0, stripe_subscription_id = '' WHERE id = ?", ws.id);
      return { url: '#/settings/billing', note: 'Sandbox: subscription cancelled.' };
    }
    if (!stripe || !stripe.configured || !ws.stripe_customer_id) throw bad('No billing account yet. Choose a plan first.');
    return { url: (await stripe.portal({ ws, appUrl: billingUrl() })).url };
  });

  // Stripe tells us about payments here. Signed, so it can't be faked.
  async function stripeWebhook(req, res) {
    const raw = await new Promise((resolve, reject) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => resolve(Buffer.concat(ch).toString('utf8'))); req.on('error', reject); });
    let event;
    try { event = stripe.verify(raw, req.headers['stripe-signature']); } catch (e) { res.writeHead(400); return res.end('bad signature'); }
    const obj = event.data && event.data.object;
    try {
      if (event.type.startsWith('customer.subscription.')) {
        const wsId = Number(obj.metadata && obj.metadata.workspace_id) || (db.get('SELECT id FROM workspaces WHERE stripe_subscription_id = ? OR stripe_customer_id = ?', obj.id, obj.customer) || {}).id;
        if (wsId) {
          const f = stripe.planFromSubscription(obj);
          if (event.type === 'customer.subscription.deleted' || ['canceled', 'unpaid', 'incomplete_expired'].includes(f.sub_status)) { f.plan = 'trial'; f.sub_status = 'canceled'; f.extra_seats = 0; }
          applySubscription(wsId, f);
          db.audit(wsId, 'stripe', 'plan_changed', '', `${f.plan} (${f.sub_status}), ${f.extra_seats} extra users`);
        }
      } else if (event.type === 'checkout.session.completed' && obj.client_reference_id) {
        db.run("UPDATE workspaces SET stripe_customer_id = ? WHERE id = ? AND (stripe_customer_id = '' OR stripe_customer_id IS NULL)", obj.customer || '', Number(obj.client_reference_id));
      }
    } catch (e) { console.error('[stripe webhook]', e); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"received":true}');
  }

  function seedWorkspace(wsId) {
    db.audit(wsId, 'system', 'workspace_created', '', '');
  }

  /* ---------------------------------------------------------------- */
  /* HTTP handling                                                     */
  /* ---------------------------------------------------------------- */

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'That upload is too large (max 5 MB).')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        const s = Buffer.concat(chunks).toString('utf8');
        if (!s) return resolve({});
        if (/x-www-form-urlencoded/.test(req.headers['content-type'] || '')) return resolve(Object.fromEntries(new URLSearchParams(s)));
        try { resolve(JSON.parse(s)); } catch (e) { reject(bad('Invalid request.')); }
      });
      req.on('error', reject);
    });
  }

  function cookie(req, name) {
    const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? m[1] : '';
  }

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }

  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

  function serveStatic(req, res, pathname) {
    let file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(PUBLIC)) { res.writeHead(404); return res.end(); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300' });
    fs.createReadStream(file).pipe(res);
  }

  function unsubscribePage(res, done) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
<style>body{margin:0;font-family:Arial,sans-serif;background:#f4f6f9;color:#132238;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}main{background:#fff;border:1px solid #dfe5ec;border-radius:12px;padding:32px;max-width:420px;text-align:center}button{min-height:44px;padding:0 22px;border:0;border-radius:8px;background:#02204b;color:#fff;font-size:15px;font-weight:700;cursor:pointer}</style></head>
<body><main>${done ? '<h1 style="font-size:22px">You\'re unsubscribed</h1><p>You won\'t receive any more emails from this sender.</p>'
    : '<h1 style="font-size:22px">Unsubscribe?</h1><p>Click below and you won\'t receive any more emails from this sender.</p><form method="post"><button type="submit">Unsubscribe</button></form>'}</main></body></html>`);
  }

  return async function handler(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    try {
      // Public one-click unsubscribe (RFC 8058): POST unsubscribes, GET shows a confirm button.
      const um = pathname.match(/^\/u\/([A-Za-z0-9_-]{10,})$/);
      if (um) {
        if (req.method === 'POST') { await readBody(req).catch(() => ({})); engine.unsubscribe(um[1]); return unsubscribePage(res, true); }
        return unsubscribePage(res, false);
      }
      if (pathname === '/api/stripe/webhook' && req.method === 'POST' && stripe) return stripeWebhook(req, res);
      if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

      const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!route) throw new HttpError(404, 'Not found.');
      const params = {};
      const m = pathname.match(route.re);
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

      if (req.method !== 'GET' && req.headers['x-gridline'] !== '1') throw new HttpError(403, 'Request blocked.');

      const ctx = { params, query: Object.fromEntries(url.searchParams) };
      if (route.auth) {
        const token = cookie(req, 'gl_session');
        const sess = token && db.get('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', U.sha256(token), Date.now());
        if (!sess) throw new HttpError(401, 'Please log in.');
        ctx.user = db.get('SELECT * FROM users WHERE id = ?', sess.user_id);
        if (!ctx.user) throw new HttpError(401, 'Please log in.');
        ctx.ws = wsFor(ctx.user);
        ctx.token = token;
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await route.handler(req, res, body, ctx);
      if (out && out.__raw !== undefined) {
        res.writeHead(200, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"` });
        return res.end(out.__raw);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error('[http]', e);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message }));
    }
  };
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }

/* ---------------------------------------------------------------- */
/* Start                                                             */
/* ---------------------------------------------------------------- */

if (require.main === module) {
  const secret = process.env.APP_SECRET;
  if (!secret) { console.error('Set APP_SECRET (a long random string) before starting.'); process.exit(1); }
  U.setSecret(secret);
  const db = open(process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'gridline.db'));
  // APP_URL wins; otherwise use the address the host gives us (Render or Railway).
  const appUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '')).replace(/\/$/, '');
  const sandbox = process.env.SANDBOX === '1';
  // Sandbox mode: everything works, but no real email is sent or read. For demos and testing.
  const transport = sandbox ? {
    verify: async () => true,
    send: async (inbox, m) => console.log(`[sandbox] would send from ${inbox.email} to ${m.to}`),
    fetch: async (inbox, st) => ({ messages: [], lastUid: st.lastUid || 1, uidValidity: '1' })
  } : undefined;
  const engine = new Engine(db, { appUrl, transport });
  // Griddy uses Claude when GRIDDY_API_KEY is set; otherwise it answers from its built-in guide (free).
  const ai = { apiKey: process.env.GRIDDY_API_KEY || '', model: process.env.GRIDDY_MODEL || 'claude-haiku-4-5', dailyLimit: Number(process.env.GRIDDY_DAILY_LIMIT || 40) };
  // Payments through Stripe (see the launch guide). Without these, sandbox mode shows a demo checkout.
  const stripe = new Stripe({
    secretKey: process.env.STRIPE_SECRET_KEY || '', webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    prices: { pro: process.env.STRIPE_PRICE_PRO || '', seat: process.env.STRIPE_PRICE_SEAT || '', enterprise: process.env.STRIPE_PRICE_ENTERPRISE || '' }
  });
  const handler = createApp({ db, engine, appUrl, secureCookies: appUrl.startsWith('https://'), transport, sandbox, ai, stripe });
  if (sandbox) console.log('SANDBOX MODE: no real emails will be sent.');
  const port = Number(process.env.PORT || 3000);
  http.createServer(handler).listen(port, () => console.log(`Gridline.io running on port ${port}`));
  if (process.env.ENGINE !== 'off') engine.start();
}

module.exports = { createApp };
