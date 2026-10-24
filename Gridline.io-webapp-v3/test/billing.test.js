'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const U = require('../src/util');
const { open } = require('../src/db');
const { Engine } = require('../src/engine');
const { createApp } = require('../src/server');
const { Stripe } = require('../src/billing');
const plans = require('../src/plans');

U.setSecret('test-secret-test-secret-test-secret-123');
const prices = { pro: 'price_pro', seat: 'price_seat', enterprise: 'price_ent' };

async function start({ stripe, sandbox } = {}) {
  const db = open(':memory:');
  const engine = new Engine(db, { appUrl: 'http://x' });
  const server = http.createServer(createApp({ db, engine, appUrl: 'http://x', stripe, sandbox }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-gridline': '1', cookie, ...headers }, body: typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
  };
  const call = client();
  await call('POST', '/api/signup', { name: 'Alex Morgan', email: 'alex@acme.test', password: 'longpassword1', company: 'Acme Ltd' });
  return { server, call, client, db, ws: () => db.get('SELECT * FROM workspaces') };
}

test('a new account gets a 7-day trial with limits', async () => {
  const t = await start();
  const me = (await t.call('GET', '/api/me')).data;
  assert.strictEqual(me.plan.plan, 'trial');
  assert.strictEqual(me.plan.trial_days_left, 7);
  assert.strictEqual(me.plan.emails_limit, 100);
  assert.strictEqual(me.plan.can_send, true);
  // Lead limit
  t.db.raw.exec('BEGIN');
  for (let i = 0; i < 200; i++) t.db.run('INSERT INTO leads (workspace_id, email, unsubscribe_token, created_at) VALUES (1, ?, ?, 0)', `p${i}@x.test`, 't' + i);
  t.db.raw.exec('COMMIT');
  const r = await t.call('POST', '/api/leads', { email: 'one@more.test' });
  assert.strictEqual(r.status, 402);
  assert.match(r.data.error, /200 leads/);
  // Invite blocked: trial has 1 user
  const inv = await t.call('POST', '/api/team/invite', { email: 'sam@acme.test' });
  assert.strictEqual(inv.status, 402);
  t.server.close();
});

test('trial ends after 7 days or 100 emails, and sending stops', () => {
  const db = open(':memory:');
  const now = Date.parse('2026-11-01T10:00:00Z');
  db.run("INSERT INTO workspaces (name, trial_ends_at, created_at) VALUES ('A', ?, ?)", now + plans.DAY, now);
  const ws = db.get('SELECT * FROM workspaces');
  assert.strictEqual(plans.status(db, ws, now).can_send, true);
  assert.match(plans.status(db, ws, now + 2 * plans.DAY).locked, /trial has ended/);
  for (let i = 0; i < 100; i++) db.run("INSERT INTO messages (workspace_id, direction, step_position, created_at) VALUES (1, 'out', 1, ?)", now);
  assert.match(plans.status(db, ws, now).locked, /100 trial emails/);
  db.run("UPDATE workspaces SET plan = 'pro', sub_status = 'active'");
  assert.strictEqual(plans.status(db, db.get('SELECT * FROM workspaces'), now + 30 * plans.DAY).can_send, true);
});

test('Stripe checkout is created with Pro + extra users, and a signed webhook activates the plan', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push({ url, body: opts.body }); return { ok: true, json: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }) }; };
  const stripe = new Stripe({ secretKey: 'sk_test', webhookSecret: 'whsec_test', prices, fetchImpl: fakeFetch });
  const t = await start({ stripe });
  const r = await t.call('POST', '/api/billing/checkout', { plan: 'pro', extra_seats: 2 });
  assert.strictEqual(r.data.url, 'https://checkout.stripe.test/cs_1');
  const body = decodeURIComponent(calls[0].body);
  assert.match(body, /line_items\[0\]\[price\]=price_pro/);
  assert.match(body, /line_items\[1\]\[price\]=price_seat&line_items\[1\]\[quantity\]=2/);
  assert.match(body, /subscription_data\[metadata\]\[workspace_id\]=1/);

  const event = JSON.stringify({ type: 'customer.subscription.created', data: { object: {
    id: 'sub_1', customer: 'cus_1', status: 'active', current_period_end: 1800000000, metadata: { workspace_id: '1' },
    items: { data: [{ price: { id: 'price_pro' }, quantity: 1 }, { price: { id: 'price_seat' }, quantity: 2 }] } } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${event}`).digest('hex');
  const forged = await t.call('POST', '/api/stripe/webhook', event, { 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` });
  assert.strictEqual(forged.status, 400);
  assert.strictEqual(t.ws().plan, 'trial');
  const ok = await t.call('POST', '/api/stripe/webhook', event, { 'stripe-signature': `t=${ts},v1=${sig}` });
  assert.strictEqual(ok.status, 200);
  const me = (await t.call('GET', '/api/me')).data.plan;
  assert.strictEqual(me.plan, 'pro');
  assert.strictEqual(me.seats, 3);
  assert.strictEqual(me.inbox_limit, 9);

  // Seats: invite two people, third is refused.
  assert.strictEqual((await t.call('POST', '/api/team/invite', { email: 'a@acme.test' })).status, 200);
  const inv = await t.call('POST', '/api/team/invite', { email: 'b@acme.test' });
  assert.strictEqual((await t.call('POST', '/api/team/invite', { email: 'c@acme.test' })).status, 402);
  // The invitee joins and becomes a member who can't change billing.
  const token = inv.data.link.split('/join/')[1];
  const joiner = t.client();
  assert.strictEqual((await joiner('GET', '/api/join/' + token)).data.email, 'b@acme.test');
  assert.strictEqual((await joiner('POST', '/api/join/' + token, { name: 'Bea', password: 'longpassword2' })).status, 200);
  const jm = (await joiner('GET', '/api/me')).data;
  assert.strictEqual(jm.role, 'member');
  assert.strictEqual(jm.workspace.name, 'Acme Ltd');
  assert.strictEqual((await joiner('POST', '/api/billing/checkout', { plan: 'enterprise' })).status, 403);

  // Cancelled subscription locks sending.
  const del = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'canceled', metadata: { workspace_id: '1' }, items: { data: [{ price: { id: 'price_pro' }, quantity: 1 }] } } } });
  const sig2 = crypto.createHmac('sha256', 'whsec_test').update(`${ts}.${del}`).digest('hex');
  await t.call('POST', '/api/stripe/webhook', del, { 'stripe-signature': `t=${ts},v1=${sig2}` });
  t.db.run('UPDATE workspaces SET trial_ends_at = 0');
  const after = (await t.call('GET', '/api/me')).data.plan;
  assert.strictEqual(after.can_send, false);
  assert.match(after.locked, /subscription has ended/);
  t.server.close();
});

test('sandbox demo checkout switches plan without Stripe', async () => {
  const t = await start({ sandbox: true });
  const r = await t.call('POST', '/api/billing/checkout', { plan: 'enterprise' });
  assert.match(r.data.url, /^#/);
  const me = (await t.call('GET', '/api/me')).data.plan;
  assert.strictEqual(me.plan, 'enterprise');
  assert.strictEqual(me.seats, Infinity === me.seats ? Infinity : null);
  t.server.close();
});
