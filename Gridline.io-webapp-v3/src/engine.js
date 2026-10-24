'use strict';
const plans = require('./plans');
// The outreach engine: runs every minute, sends due emails, creates call tasks,
// reads replies, handles opt-outs and bounces.
const smtp = require('./smtp');
const imap = require('./imap');
const { parseMessage, buildMessage, newMessageId } = require('./mime');
const { renderEmail, renderScript } = require('./render');
const { classify, bouncedAddresses } = require('./classify');
const { leadBlockReason, isSuppressed, suppress } = require('./compliance');
const { decrypt, dayKey, zoned, domainOf, normEmail } = require('./util');

const DAY = 86400000;
const POLL_EVERY = 4 * 60000;

function defaultTransport() {
  return {
    async send(inbox, { to, raw }) {
      return smtp.sendMail({ host: inbox.smtp_host, port: inbox.smtp_port, user: inbox.username, pass: decrypt(inbox.pass_enc), from: inbox.email, to, raw });
    },
    async fetch(inbox, state) {
      return imap.fetchNew({ host: inbox.imap_host, port: inbox.imap_port, user: inbox.username, pass: decrypt(inbox.pass_enc) }, state);
    }
  };
}

class Engine {
  constructor(db, opts = {}) {
    this.db = db;
    this.transport = opts.transport || defaultTransport();
    this.appUrl = (opts.appUrl || '').replace(/\/$/, '');
    this.now = opts.now || (() => Date.now());
    this.rng = opts.rng || Math.random;
    this.running = false;
    this.lastHousekeeping = '';
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((e) => console.error('[engine]', e)), 60000);
    setTimeout(() => this.tick().catch((e) => console.error('[engine]', e)), 5000);
  }

  stop() { clearInterval(this.timer); }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.processDue();
      await this.pollInboxes();
      this.housekeeping();
    } finally {
      this.running = false;
    }
  }

  /* ------------------------------------------------------------ */
  /* Limits                                                       */
  /* ------------------------------------------------------------ */

  limitToday(inbox) {
    const now = this.now();
    if (!inbox.started_at) return Math.min(inbox.ramp_start, inbox.daily_limit);
    const days = Math.max(0, Math.floor((now - inbox.started_at) / DAY));
    return Math.min(inbox.daily_limit, inbox.ramp_start + inbox.ramp_step * days);
  }

  sentToday(inbox, tz) {
    const r = this.db.get('SELECT count FROM sends WHERE inbox_id = ? AND day = ?', inbox.id, dayKey(this.now(), tz));
    return r ? r.count : 0;
  }

  hasCapacity(inbox, tz) {
    return inbox.status === 'active' && (inbox.next_send_at || 0) <= this.now() && this.sentToday(inbox, tz) < this.limitToday(inbox);
  }

  inWindow(campaign, tz) {
    const z = zoned(this.now(), tz);
    const days = String(campaign.days || '').split(',').map(Number);
    return days.includes(z.dow) && z.hour >= campaign.start_hour && z.hour < campaign.end_hour;
  }

  /* ------------------------------------------------------------ */
  /* Sending                                                      */
  /* ------------------------------------------------------------ */

  async processDue() {
    const db = this.db;
    const campaigns = db.all(`SELECT c.*, w.timezone AS tz FROM campaigns c JOIN workspaces w ON w.id = c.workspace_id WHERE c.status = 'running'`);
    for (const c of campaigns) {
      if (!this.inWindow(c, c.tz)) continue;
      const ws = db.get('SELECT * FROM workspaces WHERE id = ?', c.workspace_id);
      if (!plans.status(db, ws, this.now()).can_send) continue; // trial over or used up: nothing sends until they upgrade
      const steps = db.all('SELECT * FROM steps WHERE campaign_id = ? ORDER BY position', c.id);
      const inboxes = db.all(`SELECT i.* FROM inboxes i JOIN campaign_inboxes ci ON ci.inbox_id = i.id WHERE ci.campaign_id = ?`, c.id);
      const due = db.all(`SELECT * FROM enrollments WHERE campaign_id = ? AND status IN ('queued','active') AND next_due_at <= ?
                          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, next_due_at, id LIMIT 200`, c.id, this.now());
      for (const e of due) {
        await this.advance(ws, c, steps, inboxes, e);
      }
      const left = db.get(`SELECT COUNT(*) n FROM enrollments WHERE campaign_id = ? AND status IN ('queued','active')`, c.id).n;
      if (left === 0 && due.length === 0 && db.get('SELECT COUNT(*) n FROM enrollments WHERE campaign_id = ?', c.id).n > 0) {
        db.run(`UPDATE campaigns SET status = 'completed' WHERE id = ?`, c.id);
      }
    }
  }

  async advance(ws, c, steps, inboxes, e) {
    const db = this.db;
    const lead = db.get('SELECT * FROM leads WHERE id = ?', e.lead_id);
    if (!lead) { db.run(`UPDATE enrollments SET status = 'stopped', note = 'Lead deleted' WHERE id = ?`, e.id); return; }
    if (isSuppressed(db, ws.id, lead.email) || ['opted_out', 'bounced'].includes(lead.status)) {
      db.run(`UPDATE enrollments SET status = 'stopped', note = 'On Do Not Contact list' WHERE id = ?`, e.id);
      return;
    }
    const step = steps.find((s) => s.position === e.current_step + 1);
    if (!step) { db.run(`UPDATE enrollments SET status = 'completed' WHERE id = ?`, e.id); return; }
    const next = steps.find((s) => s.position === step.position + 1);
    const nextDue = next ? this.now() + next.delay_days * DAY : 0;

    if (step.type === 'call') {
      const inbox = inboxes.find((i) => i.id === e.inbox_id) || inboxes[0];
      db.run(`INSERT INTO tasks (workspace_id, lead_id, enrollment_id, campaign_id, step_position, kind, reason, script, due_day, created_at)
              VALUES (?,?,?,?,?, 'call', ?, ?, ?, ?)`,
        ws.id, lead.id, e.id, c.id, step.position, `Step ${step.position} of "${c.name}"`, renderScript(step, lead, inbox), dayKey(this.now(), ws.timezone), this.now());
      db.run(`UPDATE enrollments SET current_step = ?, status = ?, next_due_at = ? WHERE id = ?`,
        step.position, next ? 'active' : 'completed', nextDue, e.id);
      return;
    }

    const isFirstEmail = !e.first_message_id;
    if (!plans.status(db, ws, this.now()).can_send) return; // stop exactly at the trial email limit
    if (isFirstEmail) {
      const why = leadBlockReason(db, ws, lead);
      if (why) {
        db.run(`UPDATE enrollments SET status = 'blocked', note = ? WHERE id = ?`, why, e.id);
        db.audit(ws.id, 'system', 'blocked', lead.email, why);
        return;
      }
      if (c.one_per_company) {
        const dom = domainOf(lead.email);
        const today = dayKey(this.now(), ws.timezone);
        const started = db.all(`SELECT l.email, m.created_at FROM messages m JOIN leads l ON l.id = m.lead_id
                                WHERE m.workspace_id = ? AND m.direction = 'out' AND m.step_position IS NOT NULL
                                AND m.created_at > ? AND l.id != ?`, ws.id, this.now() - 2 * DAY, lead.id)
          .some((r) => domainOf(r.email) === dom && dayKey(r.created_at, ws.timezone) === today);
        if (started) return; // try again tomorrow
      }
    }

    // Catch template problems (like a missing first name) straight away, before waiting for an inbox.
    const check = renderEmail({ ws, lead, inbox: inboxes.find((i) => i.id === e.inbox_id) || inboxes[0], step, firstEmail: isFirstEmail, unsubscribeUrl: '', rng: this.rng });
    if (check.errors.length) {
      db.run(`UPDATE enrollments SET status = 'blocked', note = ? WHERE id = ?`, 'Email not sent: ' + check.errors.join('; '), e.id);
      db.audit(ws.id, 'system', 'blocked', lead.email, check.errors.join('; '));
      return;
    }

    // Keep a conversation on the same inbox so replies thread properly.
    let inbox = e.inbox_id ? inboxes.find((i) => i.id === e.inbox_id) : null;
    if (inbox && !this.hasCapacity(inbox, ws.timezone)) return;
    if (!inbox) {
      inbox = inboxes.filter((i) => this.hasCapacity(i, ws.timezone))
        .sort((a, b) => this.sentToday(a, ws.timezone) / this.limitToday(a) - this.sentToday(b, ws.timezone) / this.limitToday(b))[0];
      if (!inbox) return;
    }

    const unsubscribeUrl = this.appUrl ? `${this.appUrl}/u/${lead.unsubscribe_token}` : '';
    const r = renderEmail({ ws, lead, inbox, step, firstEmail: isFirstEmail, unsubscribeUrl, rng: this.rng });
    if (r.errors.length) {
      db.run(`UPDATE enrollments SET status = 'blocked', note = ? WHERE id = ?`, 'Email not sent: ' + r.errors.join('; '), e.id);
      db.audit(ws.id, 'system', 'blocked', lead.email, r.errors.join('; '));
      return;
    }

    let subject = r.subject;
    let inReplyTo = '', references = '';
    if (!isFirstEmail && !subject) {
      subject = 'Re: ' + String(e.subject).replace(/^re:\s*/i, '');
      inReplyTo = e.last_message_id;
      references = [e.first_message_id, e.last_message_id].filter((v, i, a) => v && a.indexOf(v) === i).join(' ');
    }
    if (!subject) subject = e.subject || '(no subject)';

    const messageId = newMessageId(inbox.email);
    const raw = buildMessage({
      fromName: inbox.from_name, fromEmail: inbox.email, to: lead.email, subject, text: r.text, html: r.html,
      messageId, inReplyTo, references, unsubscribeUrl,
      unsubscribeMailto: `mailto:${inbox.email}?subject=unsubscribe`
    });

    try {
      await this.transport.send(inbox, { to: lead.email, raw });
    } catch (err) {
      const authFail = /login|auth|535|534|password/i.test(err.message);
      db.run(`UPDATE inboxes SET last_error = ?, status = ?, next_send_at = ? WHERE id = ?`,
        err.message.slice(0, 300), authFail ? 'error' : inbox.status, this.now() + 15 * 60000, inbox.id);
      inbox.status = authFail ? 'error' : inbox.status;
      inbox.next_send_at = this.now() + 15 * 60000;
      db.audit(ws.id, 'system', 'send_failed', lead.email, err.message.slice(0, 200));
      return;
    }

    const now = this.now();
    const gap = Math.round((90 + this.rng() * 210) * 1000); // 1.5–5 minutes between emails per inbox
    db.tx(() => {
      db.run(`INSERT INTO messages (workspace_id, enrollment_id, lead_id, inbox_id, direction, step_position, message_id, in_reply_to, subject, body_text, from_email, to_email, label, is_read, created_at)
              VALUES (?,?,?,?, 'out', ?,?,?,?,?,?,?, '', 1, ?)`,
        ws.id, e.id, lead.id, inbox.id, step.position, messageId, inReplyTo, subject, r.bodyText, inbox.email, lead.email, now);
      db.run(`INSERT INTO sends (inbox_id, day, count) VALUES (?, ?, 1) ON CONFLICT(inbox_id, day) DO UPDATE SET count = count + 1`, inbox.id, dayKey(now, ws.timezone));
      db.run(`UPDATE inboxes SET next_send_at = ?, started_at = COALESCE(started_at, ?), last_error = '' WHERE id = ?`, now + gap, now, inbox.id);
      db.run(`UPDATE enrollments SET current_step = ?, status = ?, next_due_at = ?, inbox_id = ?,
              first_message_id = CASE WHEN first_message_id = '' THEN ? ELSE first_message_id END,
              last_message_id = ?, subject = CASE WHEN subject = '' THEN ? ELSE subject END, note = '' WHERE id = ?`,
        step.position, next ? 'active' : 'completed', nextDue, inbox.id, messageId, messageId, subject, e.id);
      db.run(`UPDATE leads SET status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END, last_activity_at = ? WHERE id = ?`, now, lead.id);
    });
    inbox.next_send_at = now + gap;
    inbox.started_at = inbox.started_at || now;
    db.audit(ws.id, 'system', 'email_sent', lead.email, `${c.name} – step ${step.position}: ${subject}`);
  }

  /* ------------------------------------------------------------ */
  /* Reading replies                                              */
  /* ------------------------------------------------------------ */

  async pollInboxes(force = false) {
    const db = this.db;
    const inboxes = db.all(`SELECT * FROM inboxes WHERE status = 'active' AND (? OR last_polled_at < ?)`, force ? 1 : 0, this.now() - POLL_EVERY);
    for (const inbox of inboxes) {
      try {
        const res = await this.transport.fetch(inbox, { lastUid: inbox.last_uid, uidValidity: inbox.uid_validity });
        for (const m of res.messages) {
          try { this.handleIncoming(inbox, parseMessage(m.raw)); } catch (e) { console.error('[engine] message', e); }
        }
        db.run(`UPDATE inboxes SET last_uid = ?, uid_validity = ?, last_polled_at = ?, last_error = '' WHERE id = ?`,
          res.lastUid, res.uidValidity || inbox.uid_validity, this.now(), inbox.id);
      } catch (err) {
        const authFail = /login|auth|credentials|password/i.test(err.message);
        db.run(`UPDATE inboxes SET last_polled_at = ?, last_error = ?, status = ? WHERE id = ?`,
          this.now(), 'Reading replies: ' + err.message.slice(0, 250), authFail ? 'error' : inbox.status, inbox.id);
      }
    }
  }

  stopLead(wsId, leadId, status, note) {
    this.db.run(`UPDATE enrollments SET status = ?, note = ? WHERE lead_id = ? AND status IN ('queued','active')
                 AND campaign_id IN (SELECT id FROM campaigns WHERE workspace_id = ?)`, status, note, leadId, wsId);
  }

  handleIncoming(inbox, msg) {
    const db = this.db;
    const ws = db.get('SELECT * FROM workspaces WHERE id = ?', inbox.workspace_id);
    const now = this.now();
    const label = classify(msg);

    if (label === 'bounce') {
      for (const addr of bouncedAddresses(msg)) {
        const lead = db.get('SELECT * FROM leads WHERE workspace_id = ? AND email = ?', ws.id, normEmail(addr));
        if (!lead || lead.status === 'bounced') continue;
        db.run(`UPDATE leads SET status = 'bounced', last_activity_at = ? WHERE id = ?`, now, lead.id);
        this.stopLead(ws.id, lead.id, 'stopped', 'Email bounced');
        suppress(db, ws.id, lead.email, 'Bounced');
        db.run(`INSERT INTO messages (workspace_id, lead_id, inbox_id, direction, message_id, subject, body_text, from_email, to_email, label, is_read, created_at)
                VALUES (?,?,?, 'in', ?,?,?,?,?, 'bounce', 1, ?)`, ws.id, lead.id, inbox.id, msg.messageId, msg.subject, msg.text.slice(0, 2000), msg.from, inbox.email, now);
      }
      return;
    }

    // Match to a lead: first by the thread, then by the sender's address.
    let enrollment = null, lead = null;
    const ids = [msg.inReplyTo, ...msg.references].filter(Boolean);
    for (const id of ids) {
      const out = db.get(`SELECT * FROM messages WHERE workspace_id = ? AND direction = 'out' AND message_id = ?`, ws.id, id);
      if (out) {
        lead = db.get('SELECT * FROM leads WHERE id = ?', out.lead_id);
        if (out.enrollment_id) enrollment = db.get('SELECT * FROM enrollments WHERE id = ?', out.enrollment_id);
        break;
      }
    }
    if (!lead && msg.from) lead = db.get('SELECT * FROM leads WHERE workspace_id = ? AND email = ?', ws.id, msg.from);
    if (!lead) return; // not one of ours
    if (msg.messageId && db.get(`SELECT 1 FROM messages WHERE workspace_id = ? AND message_id = ? AND direction = 'in'`, ws.id, msg.messageId)) return;

    db.run(`INSERT INTO messages (workspace_id, enrollment_id, lead_id, inbox_id, direction, message_id, in_reply_to, subject, body_text, from_email, to_email, label, is_read, created_at)
            VALUES (?,?,?,?, 'in', ?,?,?,?,?,?,?, ?, ?)`,
      ws.id, enrollment ? enrollment.id : null, lead.id, inbox.id, msg.messageId, msg.inReplyTo, msg.subject,
      (msg.reply || msg.text).slice(0, 8000), msg.from, inbox.email, label, label === 'ooo' ? 1 : 0, now);

    if (label === 'ooo') {
      if (enrollment) db.run(`UPDATE enrollments SET note = 'Out of office reply received. Sequence continues.' WHERE id = ?`, enrollment.id);
      return;
    }

    if (label === 'opted_out') {
      db.run(`UPDATE leads SET status = 'opted_out', last_activity_at = ? WHERE id = ?`, now, lead.id);
      this.stopLead(ws.id, lead.id, 'stopped', 'Asked not to be contacted');
      db.run(`UPDATE tasks SET status = 'done', outcome = 'opted_out', completed_at = ? WHERE lead_id = ? AND status = 'open'`, now, lead.id);
      suppress(db, ws.id, lead.email, 'Asked not to be contacted (email reply)');
      db.audit(ws.id, 'system', 'opted_out', lead.email, 'Reply: ' + (msg.reply || '').slice(0, 140));
      return;
    }

    const leadStatus = label === 'interested' ? 'interested' : label === 'not_interested' ? 'not_interested' : 'replied';
    db.run(`UPDATE leads SET status = ?, last_activity_at = ? WHERE id = ?`, leadStatus, now, lead.id);
    this.stopLead(ws.id, lead.id, 'replied', 'Replied: ' + label.replace('_', ' '));
    if (label !== 'not_interested') {
      const exists = db.get(`SELECT 1 FROM tasks WHERE lead_id = ? AND status = 'open' AND kind = 'call'`, lead.id);
      if (!exists) {
        db.run(`INSERT INTO tasks (workspace_id, lead_id, enrollment_id, campaign_id, kind, reason, script, due_day, created_at)
                VALUES (?,?,?,?, 'call', ?, ?, ?, ?)`,
          ws.id, lead.id, enrollment ? enrollment.id : null, enrollment ? enrollment.campaign_id : null,
          label === 'interested' ? 'Replied: interested' : 'Replied: ' + label,
          `They wrote: "${(msg.reply || '').slice(0, 300)}"`, dayKey(now, ws.timezone), now);
      }
    }
    db.audit(ws.id, 'system', 'reply', lead.email, label);
  }

  /* ------------------------------------------------------------ */
  /* Actions from the app                                         */
  /* ------------------------------------------------------------ */

  unsubscribe(token) {
    const db = this.db;
    const lead = db.get('SELECT * FROM leads WHERE unsubscribe_token = ?', String(token || ''));
    if (!lead) return false;
    db.run(`UPDATE leads SET status = 'opted_out', last_activity_at = ? WHERE id = ?`, this.now(), lead.id);
    this.stopLead(lead.workspace_id, lead.id, 'stopped', 'Unsubscribed');
    db.run(`UPDATE tasks SET status = 'done', outcome = 'opted_out', completed_at = ? WHERE lead_id = ? AND status = 'open'`, this.now(), lead.id);
    suppress(db, lead.workspace_id, lead.email, 'Unsubscribed (link)');
    db.audit(lead.workspace_id, 'recipient', 'unsubscribed', lead.email, 'One-click unsubscribe');
    return true;
  }

  callOutcome(wsId, taskId, outcome, notes, actor) {
    const db = this.db;
    const t = db.get('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?', taskId, wsId);
    if (!t) throw new Error('Call not found.');
    const lead = db.get('SELECT * FROM leads WHERE id = ?', t.lead_id);
    const now = this.now();
    db.run(`UPDATE tasks SET status = 'done', outcome = ?, notes = ?, completed_at = ? WHERE id = ?`, outcome, notes || '', now, t.id);
    const map = {
      interested: ['interested', 'replied', 'Interested on the phone'],
      not_now: ['not_interested', 'stopped', 'Not now (phone)'],
      wrong_person: ['wrong_person', 'stopped', 'Wrong person (phone)'],
      do_not_contact: ['opted_out', 'stopped', 'Asked not to be contacted (phone)']
    };
    if (map[outcome]) {
      const [ls, es, note] = map[outcome];
      db.run('UPDATE leads SET status = ?, last_activity_at = ? WHERE id = ?', ls, now, lead.id);
      this.stopLead(wsId, lead.id, es, note);
      if (outcome === 'do_not_contact') suppress(db, wsId, lead.email, 'Asked on the phone', actor);
    } else {
      db.run('UPDATE leads SET last_activity_at = ? WHERE id = ?', now, lead.id);
    }
    db.audit(wsId, actor, 'call', lead.email, outcome + (notes ? ': ' + notes.slice(0, 140) : ''));
  }

  /* ------------------------------------------------------------ */
  /* Housekeeping: data retention                                 */
  /* ------------------------------------------------------------ */

  housekeeping() {
    const today = dayKey(this.now(), 'Europe/London');
    if (this.lastHousekeeping === today) return;
    this.lastHousekeeping = today;
    const db = this.db;
    for (const ws of db.all('SELECT id, retention_months FROM workspaces WHERE retention_months > 0')) {
      const cutoff = this.now() - ws.retention_months * 30 * DAY;
      const old = db.all(`SELECT id, email FROM leads WHERE workspace_id = ? AND status NOT IN ('interested')
                          AND COALESCE(last_activity_at, created_at) < ?
                          AND id NOT IN (SELECT lead_id FROM enrollments WHERE status IN ('queued','active'))`, ws.id, cutoff);
      if (!old.length) continue;
      db.tx(() => {
        for (const l of old) db.run('DELETE FROM leads WHERE id = ?', l.id);
      });
      db.audit(ws.id, 'system', 'retention_delete', '', `${old.length} inactive leads deleted after ${ws.retention_months} months`);
    }
    db.run('DELETE FROM sessions WHERE expires_at < ?', this.now());
  }
}

module.exports = { Engine };
