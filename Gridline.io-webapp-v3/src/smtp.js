'use strict';
// Minimal, standards-based SMTP client: implicit TLS (465) or STARTTLS (587), AUTH PLAIN/LOGIN.
const net = require('node:net');
const tls = require('node:tls');
const os = require('node:os');

class SmtpError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

function connect(opts) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(new SmtpError('Could not connect to ' + opts.host + ':' + opts.port + ' (' + e.message + ')'));
    const sock = opts.port === 465 && !opts.insecure
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host }, () => resolve(sock))
      : net.connect({ host: opts.host, port: opts.port }, () => resolve(sock));
    sock.once('error', onErr);
    sock.setTimeout(opts.timeout || 30000, () => sock.destroy(new Error('timed out')));
  });
}

function reader(sock) {
  let buf = '';
  let waiting = null;
  let failure = null;
  const tryResolve = () => {
    if (!waiting) return;
    const lines = buf.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const resp = lines.slice(0, i + 1);
        buf = lines.slice(i + 1).join('\r\n');
        const w = waiting; waiting = null;
        w.resolve({ code: Number(resp[resp.length - 1].slice(0, 3)), lines: resp.map((l) => l.slice(4)), text: resp.join('\n') });
        return;
      }
    }
  };
  const onData = (d) => { buf += d.toString('utf8'); tryResolve(); };
  const onFail = (e) => { failure = e || new Error('connection closed'); if (waiting) { const w = waiting; waiting = null; w.reject(failure); } };
  sock.on('data', onData);
  sock.on('error', onFail);
  sock.on('close', () => onFail(new Error('connection closed by server')));
  return {
    next() {
      return new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        waiting = { resolve, reject };
        tryResolve();
      });
    },
    detach() { sock.removeListener('data', onData); }
  };
}

async function sendMail(opts) {
  // opts: host, port, user, pass, from, to (string), raw (string), insecure (tests only)
  let sock = await connect(opts);
  let r = reader(sock);
  const expect = async (codes, what) => {
    const res = await r.next();
    if (!codes.includes(res.code)) throw new SmtpError(`${what} failed: ${res.text}`, res.code);
    return res;
  };
  const cmd = async (line, codes, what) => { sock.write(line + '\r\n'); return expect(codes, what || line.split(' ')[0]); };

  try {
    await expect([220], 'Greeting');
    const name = (os.hostname() || 'gridline.io').replace(/[^A-Za-z0-9.-]/g, '') || 'gridline.io';
    let ehlo = await cmd('EHLO ' + name, [250], 'EHLO');

    const secure = sock instanceof tls.TLSSocket;
    if (!secure && !opts.insecure) {
      if (!ehlo.lines.some((l) => /^STARTTLS/i.test(l))) throw new SmtpError('This server does not offer a secure connection (STARTTLS).');
      await cmd('STARTTLS', [220], 'STARTTLS');
      r.detach();
      sock = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: opts.host }, () => resolve(s));
        s.once('error', (e) => reject(new SmtpError('Secure connection failed: ' + e.message)));
      });
      r = reader(sock);
      ehlo = await cmd('EHLO ' + name, [250], 'EHLO');
    }

    if (opts.user) {
      const authLine = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) || '';
      if (/PLAIN/i.test(authLine) || !/LOGIN/i.test(authLine)) {
        const token = Buffer.from('\0' + opts.user + '\0' + opts.pass, 'utf8').toString('base64');
        await cmd('AUTH PLAIN ' + token, [235], 'Login');
      } else {
        await cmd('AUTH LOGIN', [334], 'Login');
        await cmd(Buffer.from(opts.user, 'utf8').toString('base64'), [334], 'Login');
        await cmd(Buffer.from(opts.pass, 'utf8').toString('base64'), [235], 'Login');
      }
    }

    await cmd(`MAIL FROM:<${opts.from}>`, [250], 'Sender');
    await cmd(`RCPT TO:<${opts.to}>`, [250, 251], 'Recipient');
    await cmd('DATA', [354], 'DATA');
    const body = String(opts.raw).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    sock.write(body + (body.endsWith('\r\n') ? '' : '\r\n') + '.\r\n');
    const done = await expect([250], 'Sending');
    sock.write('QUIT\r\n');
    sock.end();
    return { response: done.text };
  } catch (e) {
    try { sock.destroy(); } catch (x) { /* ignore */ }
    throw e instanceof SmtpError ? e : new SmtpError(e.message);
  }
}

/** Connect and log in without sending, to check settings. */
async function verify(opts) {
  let sock = await connect(opts);
  let r = reader(sock);
  try {
    let res = await r.next();
    if (res.code !== 220) throw new SmtpError('Unexpected greeting: ' + res.text);
    sock.write('EHLO gridline.io\r\n');
    let ehlo = await r.next();
    if (!(sock instanceof tls.TLSSocket) && !opts.insecure) {
      sock.write('STARTTLS\r\n');
      res = await r.next();
      if (res.code !== 220) throw new SmtpError('No secure connection offered.');
      r.detach();
      sock = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket: sock, servername: opts.host }, () => resolve(s));
        s.once('error', reject);
      });
      r = reader(sock);
      sock.write('EHLO gridline.io\r\n');
      ehlo = await r.next();
    }
    const token = Buffer.from('\0' + opts.user + '\0' + opts.pass, 'utf8').toString('base64');
    sock.write('AUTH PLAIN ' + token + '\r\n');
    res = await r.next();
    if (res.code !== 235) throw new SmtpError('Login failed. Check the email address and app password. (' + res.text + ')', res.code);
    sock.write('QUIT\r\n');
    sock.end();
    return true;
  } catch (e) {
    try { sock.destroy(); } catch (x) { /* ignore */ }
    throw e instanceof SmtpError ? e : new SmtpError(e.message);
  }
}

module.exports = { sendMail, verify, SmtpError };
