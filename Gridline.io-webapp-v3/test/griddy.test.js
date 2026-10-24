'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const U = require('../src/util');
const { open } = require('../src/db');
const { Engine } = require('../src/engine');
const { createApp } = require('../src/server');
const griddy = require('../src/griddy');

U.setSecret('test-secret-test-secret-test-secret-123');

async function start(ai) {
  const db = open(':memory:');
  const engine = new Engine(db, { appUrl: 'http://x' });
  const server = http.createServer(createApp({ db, engine, appUrl: 'http://x', ai }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-gridline': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  await call('POST', '/api/signup', { name: 'Alex Morgan', email: 'alex@acme.test', password: 'longpassword1', company: 'Acme Ltd' });
  return { server, call, db };
}

test('Griddy guide answers how-to questions and greets', () => {
  assert.match(griddy.localAnswer('how do I connect gmail?', []), /app password/i);
  assert.match(griddy.localAnswer('hello', []), /Griddy/);
  assert.match(griddy.localAnswer('what is the airspeed of a swallow', []), /not sure/i);
});

test('Griddy checks the account when asked why emails are not sending', async () => {
  const { server, call } = await start({});
  const r = await call('POST', '/api/griddy', { messages: [{ role: 'user', content: "Why aren't my emails sending?" }] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.source, 'guide');
  assert.match(r.data.answer, /checked your account/);
  assert.match(r.data.answer, /No inbox is connected/);
  server.close();
});

test('Griddy uses AI when a key is set, without sending lead data, and falls back on errors', async () => {
  let sent;
  const fakeFetch = async (url, opts) => { sent = JSON.parse(opts.body); return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'AI says hi' }] }) }; };
  const { server, call } = await start({ apiKey: 'k', model: 'm', dailyLimit: 1, fetch: fakeFetch });
  const r = await call('POST', '/api/griddy', { messages: [{ role: 'user', content: 'help' }] });
  assert.strictEqual(r.data.answer, 'AI says hi');
  assert.strictEqual(sent.model, 'm');
  assert.match(sent.system, /No inbox is connected/);
  const r2 = await call('POST', '/api/griddy', { messages: [{ role: 'user', content: 'help' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'how do I import a csv' }] });
  assert.strictEqual(r2.data.source, 'guide');
  server.close();
});

test('Display choice is saved to the user', async () => {
  const { server, call } = await start({});
  assert.strictEqual((await call('GET', '/api/me')).data.user.theme, 'system');
  await call('PUT', '/api/me/display', { theme: 'dark' });
  assert.strictEqual((await call('GET', '/api/me')).data.user.theme, 'dark');
  await call('PUT', '/api/me/display', { theme: 'purple' });
  assert.strictEqual((await call('GET', '/api/me')).data.user.theme, 'system');
  server.close();
});
