'use strict';
// Minimal IMAP client: logs in, opens INBOX and fetches messages newer than the last one seen.
const net = require('node:net');
const tls = require('node:tls');

function quote(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

class ImapConn {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.done = [];          // complete logical responses not yet consumed
    this.waiter = null;
    this.tagN = 0;
    this.failure = null;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); this.wake(); });
    const fail = (e) => { this.failure = e || new Error('connection closed'); this.wake(); };
    sock.on('error', fail);
    sock.on('close', () => fail(new Error('connection closed by server')));
  }

  // Splits the buffer into logical responses, keeping literal {n} data with its response.
  parse() {
    for (;;) {
      let pos = 0;
      let text = '';
      const literals = [];
      let complete = false;
      for (;;) {
        const idx = this.buf.indexOf('\r\n', pos);
        if (idx === -1) break;
        const line = this.buf.subarray(pos, idx).toString('latin1');
        const lit = line.match(/\{(\d+)\}$/);
        if (lit) {
          const n = Number(lit[1]);
          if (this.buf.length < idx + 2 + n) break;
          literals.push(this.buf.subarray(idx + 2, idx + 2 + n));
          text += line + '\u0000';
          pos = idx + 2 + n;
          continue;
        }
        text += line;
        pos = idx + 2;
        complete = true;
        break;
      }
      if (!complete) return;
      this.done.push({ text, literals });
      this.buf = this.buf.subarray(pos);
    }
  }

  wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }

  async nextResponse() {
    while (!this.done.length) {
      if (this.failure) throw this.failure;
      await new Promise((r) => { this.waiter = r; });
    }
    return this.done.shift();
  }

  async command(cmd) {
    const tag = 'A' + (++this.tagN);
    this.sock.write(tag + ' ' + cmd + '\r\n');
    const untagged = [];
    for (;;) {
      const r = await this.nextResponse();
      if (r.text.startsWith(tag + ' ')) {
        const status = r.text.slice(tag.length + 1).split(' ')[0];
        if (status !== 'OK') {
          const what = cmd.startsWith('LOGIN') ? 'Login' : cmd.split(' ')[0];
          throw new Error(what + ' failed: ' + r.text.slice(tag.length + 1));
        }
        return untagged;
      }
      untagged.push(r);
    }
  }
}

function connect(opts) {
  return new Promise((resolve, reject) => {
    const sock = opts.insecure
      ? net.connect({ host: opts.host, port: opts.port }, () => resolve(sock))
      : tls.connect({ host: opts.host, port: opts.port, servername: opts.host }, () => resolve(sock));
    sock.once('error', (e) => reject(new Error('Could not connect to ' + opts.host + ':' + opts.port + ' (' + e.message + ')')));
    sock.setTimeout(opts.timeout || 45000, () => sock.destroy(new Error('timed out')));
  });
}

async function session(opts, fn) {
  const sock = await connect(opts);
  const c = new ImapConn(sock);
  try {
    const greet = await c.nextResponse();
    if (!/^\* (OK|PREAUTH)/i.test(greet.text)) throw new Error('Unexpected greeting: ' + greet.text);
    await c.command('LOGIN ' + quote(opts.user) + ' ' + quote(opts.pass));
    const result = await fn(c);
    try { await c.command('LOGOUT'); } catch (e) { /* ignore */ }
    return result;
  } finally {
    try { sock.end(); sock.destroy(); } catch (e) { /* ignore */ }
  }
}

/**
 * Fetch messages newer than state.lastUid. On the first run (lastUid 0) it only records
 * where the inbox is up to, so old mail is never processed.
 */
async function fetchNew(opts, state, max = 40) {
  return session(opts, async (c) => {
    const sel = await c.command('SELECT INBOX');
    let validity = '', uidNext = 0;
    for (const r of sel) {
      const v = r.text.match(/UIDVALIDITY (\d+)/i); if (v) validity = v[1];
      const n = r.text.match(/UIDNEXT (\d+)/i); if (n) uidNext = Number(n[1]);
    }
    let lastUid = Number(state.lastUid || 0);
    if (!lastUid || (state.uidValidity && validity && state.uidValidity !== validity)) {
      if (!uidNext) {
        const s = await c.command('UID SEARCH ALL');
        const ids = (s.map((r) => r.text).join(' ').match(/\d+/g) || []).map(Number);
        uidNext = (ids.length ? Math.max(...ids) : 0) + 1;
      }
      return { uidValidity: validity, lastUid: Math.max(0, uidNext - 1), messages: [] };
    }
    const fetched = await c.command(`UID FETCH ${lastUid + 1}:* (UID BODY.PEEK[]<0.98304>)`);
    const messages = [];
    for (const r of fetched) {
      const uid = Number((r.text.match(/UID (\d+)/i) || [])[1] || 0);
      if (!uid || uid <= lastUid || !r.literals.length) continue;
      messages.push({ uid, raw: r.literals[0] });
    }
    messages.sort((a, b) => a.uid - b.uid);
    const batch = messages.slice(0, max);
    const newLast = batch.length ? batch[batch.length - 1].uid : lastUid;
    return { uidValidity: validity, lastUid: newLast, messages: batch };
  });
}

async function verify(opts) {
  return session(opts, async (c) => { await c.command('SELECT INBOX'); return true; });
}

module.exports = { fetchNew, verify };
