'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { open } = require('../src/db');
const { Engine } = require('../src/engine');
const U = require('../src/util');
const { parseMessage } = require('../src/mime');

U.setSecret('test-secret-0123456789');

function setup() {
  const db = open(':memory:');
  const t0 = Date.parse('2026-10-27T10:00:00Z'); // Tuesday, 10:00 in London (GMT)
  let now = t0;
  const sent = [];
  const transport = { send: async (inbox, m) => { sent.push({ inbox: inbox.email, ...m, parsed: parseMessage(m.raw) }); }, fetch: async () => ({ messages: [], lastUid: 0 }) };
  const engine = new Engine(db, { transport, now: () => now, appUrl: 'https://app.gridline.io', rng: () => 0.5 });
  const ws = Number(db.run(`INSERT INTO workspaces (name, business_name, business_address, privacy_url, created_at) VALUES ('Acme','Acme Ltd','1 High St, Leeds','https://acme.test/privacy', ?)`, now).lastInsertRowid);
  const inbox = Number(db.run(`INSERT INTO inboxes (workspace_id, email, from_name, signature, smtp_host, smtp_port, imap_host, imap_port, username, pass_enc, daily_limit, ramp_start, ramp_step, created_at)
     VALUES (?, 'alex@acme.test', 'Alex Morgan', 'Alex\n0161 000 0000', 'h', 465, 'h', 993, 'alex@acme.test', ?, 30, 10, 2, ?)`, ws, U.encrypt('pw'), now).lastInsertRowid);
  const camp = Number(db.run(`INSERT INTO campaigns (workspace_id, name, status, lia_purpose, lia_relevance, lia_balance, created_at) VALUES (?, 'Test', 'running', 'a','b','c', ?)`, ws, now).lastInsertRowid);
  db.run(`INSERT INTO steps (campaign_id, position, type, delay_days, subject, body) VALUES (?,1,'email',0,'Quick question, {{FirstName}}','Hi {{FirstName}},\n\n{{PersonalLine}}\n\nThanks,\n{{SenderFirstName}}')`, camp);
  db.run(`INSERT INTO steps (campaign_id, position, type, delay_days, subject, body) VALUES (?,2,'call',2,'','Call {{FirstName}} at {{Company}}')`, camp);
  db.run(`INSERT INTO steps (campaign_id, position, type, delay_days, subject, body) VALUES (?,3,'email',1,'','Hi {{FirstName}}, just checking this reached you.')`, camp);
  db.run('INSERT INTO campaign_inboxes VALUES (?,?)', camp, inbox);
  const lead = (email, extra = {}) => Number(db.run(`INSERT INTO leads (workspace_id, email, first_name, company, source, personal_line, consent, unsubscribe_token, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ws, email, extra.first ?? 'Sam', extra.company ?? 'Acme Client', extra.source ?? 'their website', extra.line ?? '', extra.consent ?? 0, U.randomToken(12), now).lastInsertRowid);
  const enroll = (leadId) => db.run(`INSERT INTO enrollments (campaign_id, lead_id, status, next_due_at, created_at) VALUES (?,?, 'queued', ?, ?)`, camp, leadId, now, now);
  return { db, engine, ws, inbox, camp, sent, lead, enroll, advance: (ms) => { now += ms; }, now: () => now };
}

const MIN = 60000, DAY = 86400000;
const enr = (db, leadId) => db.get('SELECT * FROM enrollments WHERE lead_id = ?', leadId);

test('compliance guard blocks unsafe contacts and sends the safe one', async () => {
  const t = setup();
  const a = t.lead('jo@client-a.co.uk', { first: 'Jo', line: 'Saw your new site in Stafford.' });
  const b = t.lead('kim@client-a.co.uk', { first: 'Kim' });
  const c = t.lead('pat@gmail.com');
  const d = t.lead('lee@client-d.co.uk', { source: '' });
  const e = t.lead('max@banned.co.uk');
  const f = t.lead('noname@client-f.co.uk', { first: '' });
  t.db.run(`INSERT INTO suppression (workspace_id, value, reason, created_at) VALUES (?, 'banned.co.uk', 'test', 0)`, t.ws);
  [a, b, c, d, e, f].forEach(t.enroll);

  await t.engine.processDue();
  assert.strictEqual(t.sent.length, 1, 'one email per inbox per tick');
  const m = t.sent[0];
  assert.strictEqual(m.to, 'jo@client-a.co.uk');
  assert.strictEqual(m.parsed.subject, 'Quick question, Jo');
  assert.match(m.parsed.text, /Hi Jo,\n\nSaw your new site in Stafford\.\n\nThanks,\nAlex/);
  assert.match(m.parsed.text, /We found your business details via their website\. How we use them: https:\/\/acme\.test\/privacy/);
  assert.match(m.parsed.text, /Acme Ltd · 1 High St, Leeds/);
  assert.match(m.raw, /List-Unsubscribe: <https:\/\/app\.gridline\.io\/u\//);
  assert.match(m.raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);

  assert.strictEqual(enr(t.db, c).status, 'blocked');
  assert.match(enr(t.db, c).note, /Personal email/);
  assert.strictEqual(enr(t.db, d).status, 'blocked');
  assert.match(enr(t.db, d).note, /Source/);
  assert.strictEqual(enr(t.db, e).status, 'stopped');
  assert.strictEqual(enr(t.db, f).status, 'blocked');
  assert.match(enr(t.db, f).note, /FirstName is empty/);
  assert.strictEqual(enr(t.db, b).status, 'queued', 'same company waits');

  // Five minutes later: inbox free again, but Kim's company already had an email today.
  t.advance(6 * MIN);
  await t.engine.processDue();
  assert.strictEqual(t.sent.length, 1);

  // Next day Kim gets hers.
  t.advance(DAY);
  await t.engine.processDue();
  assert.strictEqual(t.sent.length, 2);
  assert.strictEqual(t.sent[1].to, 'kim@client-a.co.uk');
});

test('call step creates a task, follow-up threads, reply stops sequence and books a call', async () => {
  const t = setup();
  const a = t.lead('jo@client-a.co.uk', { first: 'Jo' });
  t.enroll(a);
  await t.engine.processDue();
  const first = t.sent[0];

  t.advance(2 * DAY);
  await t.engine.processDue();
  const task = t.db.get('SELECT * FROM tasks WHERE lead_id = ?', a);
  assert.ok(task, 'call task created');
  assert.strictEqual(task.script, 'Call Jo at Acme Client');
  assert.strictEqual(t.sent.length, 1);

  t.advance(DAY + MIN);
  await t.engine.processDue();
  assert.strictEqual(t.sent.length, 2);
  const follow = t.sent[1];
  assert.strictEqual(follow.parsed.subject, 'Re: Quick question, Jo');
  assert.strictEqual(follow.parsed.inReplyTo, first.parsed.messageId);
  assert.strictEqual(enr(t.db, a).status, 'completed');

  // A reply arrives.
  const b = t.lead('sam@client-b.co.uk', { first: 'Sam' });
  t.enroll(b);
  t.advance(10 * MIN);
  await t.engine.processDue();
  const toSam = t.sent[2];
  const reply = `From: Sam <sam@client-b.co.uk>\r\nSubject: Re: ${toSam.parsed.subject}\r\nMessage-ID: <rep1@client-b.co.uk>\r\nIn-Reply-To: ${toSam.parsed.messageId}\r\n\r\nSounds good, give me a call on Thursday.\r\n\r\nOn Tue, Alex wrote:\r\n> Hi Sam`;
  const inbox = t.db.get('SELECT * FROM inboxes');
  t.engine.handleIncoming(inbox, parseMessage(reply));
  assert.strictEqual(enr(t.db, b).status, 'replied');
  assert.strictEqual(t.db.get('SELECT status FROM leads WHERE id = ?', b).status, 'interested');
  const callBack = t.db.get(`SELECT * FROM tasks WHERE lead_id = ?`, b);
  assert.strictEqual(callBack.reason, 'Replied: interested');
  // Duplicate delivery of the same reply is ignored.
  t.engine.handleIncoming(inbox, parseMessage(reply));
  assert.strictEqual(t.db.get(`SELECT COUNT(*) n FROM messages WHERE direction = 'in'`).n, 1);
});

test('out-of-office does not stop the sequence; opt-out and bounce suppress', async () => {
  const t = setup();
  const a = t.lead('jo@client-a.co.uk', { first: 'Jo' });
  const b = t.lead('sam@client-b.co.uk', { first: 'Sam' });
  const c = t.lead('al@client-c.co.uk', { first: 'Al' });
  [a, b, c].forEach(t.enroll);
  for (let i = 0; i < 3; i++) { await t.engine.processDue(); t.advance(6 * MIN); }
  assert.strictEqual(t.sent.length, 3);
  const inbox = t.db.get('SELECT * FROM inboxes');

  t.engine.handleIncoming(inbox, parseMessage(`From: jo@client-a.co.uk\r\nSubject: Automatic reply: Quick question\r\nAuto-Submitted: auto-replied\r\nMessage-ID: <o1@a>\r\n\r\nI am out of the office until Monday.`));
  assert.strictEqual(enr(t.db, a).status, 'active');

  t.engine.handleIncoming(inbox, parseMessage(`From: sam@client-b.co.uk\r\nSubject: Re: Quick question\r\nMessage-ID: <o2@b>\r\n\r\nPlease remove me from your list.`));
  assert.strictEqual(enr(t.db, b).status, 'stopped');
  assert.ok(t.db.get(`SELECT 1 FROM suppression WHERE value = 'sam@client-b.co.uk'`));

  t.engine.handleIncoming(inbox, parseMessage(`From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>\r\nSubject: Delivery Status Notification (Failure)\r\nX-Failed-Recipients: al@client-c.co.uk\r\nMessage-ID: <b1@g>\r\n\r\nAddress not found.`));
  assert.strictEqual(t.db.get('SELECT status FROM leads WHERE id = ?', c).status, 'bounced');
  assert.strictEqual(enr(t.db, c).status, 'stopped');
});

test('one-click unsubscribe and phone outcomes', async () => {
  const t = setup();
  const a = t.lead('jo@client-a.co.uk', { first: 'Jo' });
  t.enroll(a);
  const token = t.db.get('SELECT unsubscribe_token FROM leads WHERE id = ?', a).unsubscribe_token;
  assert.strictEqual(t.engine.unsubscribe(token), true);
  assert.strictEqual(enr(t.db, a).status, 'stopped');
  await t.engine.processDue();
  assert.strictEqual(t.sent.length, 0);

  const b = t.lead('sam@client-b.co.uk', { first: 'Sam' });
  const task = Number(t.db.run(`INSERT INTO tasks (workspace_id, lead_id, kind, due_day, created_at) VALUES (?,?, 'call', '2026-10-27', 0)`, t.ws, b).lastInsertRowid);
  t.engine.callOutcome(t.ws, task, 'do_not_contact', 'Asked us to stop', 'alex');
  assert.ok(t.db.get(`SELECT 1 FROM suppression WHERE value = 'sam@client-b.co.uk'`));
  assert.ok(t.db.get(`SELECT 1 FROM audit WHERE action = 'call' AND email = 'sam@client-b.co.uk'`));
});

test('sending window, weekends and ramp-up are respected', async () => {
  const t = setup();
  const a = t.lead('jo@client-a.co.uk', { first: 'Jo' });
  t.enroll(a);
  t.advance(-3 * 3600000); // 07:00 – before the window
  await t.engine.processDue();
  assert.strictEqual(t.sent.length, 0);
  t.advance(4 * DAY + 3 * 3600000); // Saturday 10:00
  await t.engine.processDue();
  assert.strictEqual(t.sent.length, 0);
  t.advance(2 * DAY); // Monday 10:00
  await t.engine.processDue();
  assert.strictEqual(t.sent.length, 1);
  const inbox = t.db.get('SELECT * FROM inboxes');
  assert.strictEqual(t.engine.limitToday(inbox), 10);
  t.advance(3 * DAY);
  assert.strictEqual(t.engine.limitToday(t.db.get('SELECT * FROM inboxes')), 16);
});
