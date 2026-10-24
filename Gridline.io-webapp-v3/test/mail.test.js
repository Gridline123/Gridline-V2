'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const smtp = require('../src/smtp');
const imap = require('../src/imap');
const { buildMessage, parseMessage, newMessageId } = require('../src/mime');

function fakeSmtp() {
  const received = [];
  const server = net.createServer((s) => {
    let mode = 'cmd', data = '', buf = '', msg = {};
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      if (mode === 'data') {
        const end = buf.indexOf('\r\n.\r\n');
        if (end === -1) return;
        msg.data = buf.slice(0, end).replace(/^\.\./gm, '.');
        buf = buf.slice(end + 5);
        received.push(msg); msg = {}; mode = 'cmd';
        s.write('250 queued\r\n');
      }
      let i;
      while (mode === 'cmd' && (i = buf.indexOf('\r\n')) > -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^EHLO/.test(line)) s.write('250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (/^AUTH PLAIN/.test(line)) {
          const [, u, p] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0');
          s.write(u === 'me@acme.test' && p === 'apppass' ? '235 ok\r\n' : '535 bad credentials\r\n');
        }
        else if (/^MAIL FROM/.test(line)) { msg.from = line; s.write('250 ok\r\n'); }
        else if (/^RCPT TO/.test(line)) { msg.to = line; s.write('250 ok\r\n'); }
        else if (line === 'DATA') { mode = 'data'; s.write('354 go\r\n'); }
        else if (line === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
        else s.write('500 ?\r\n');
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, received })));
}

function fakeImap(messages) {
  const server = net.createServer((s) => {
    s.write('* OK fake IMAP ready\r\n');
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) > -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const [tag, cmd] = line.split(' ');
        if (cmd === 'LOGIN') s.write(line.includes('"apppass"') ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        else if (cmd === 'SELECT') s.write(`* 3 EXISTS\r\n* OK [UIDVALIDITY 777] ok\r\n* OK [UIDNEXT ${messages.length + 11}] next\r\n${tag} OK [READ-WRITE] selected\r\n`);
        else if (cmd === 'UID' && line.includes('FETCH')) {
          const from = Number(line.match(/FETCH (\d+):/)[1]);
          let out = '';
          messages.forEach((m, idx) => {
            const uid = idx + 10;
            if (uid < from) return;
            const b = Buffer.from(m);
            out += `* ${idx + 1} FETCH (UID ${uid} BODY[]<0> {${b.length}}\r\n${m})\r\n`;
          });
          s.write(out + `${tag} OK fetched\r\n`);
        }
        else if (cmd === 'LOGOUT') { s.write(`* BYE\r\n${tag} OK bye\r\n`); s.end(); }
        else s.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

test('SMTP client logs in and delivers a message intact', async () => {
  const f = await fakeSmtp();
  const raw = buildMessage({ fromName: 'Alex Morgan', fromEmail: 'me@acme.test', to: 'jo@client.test', subject: 'Hello – café', text: 'Hi Jo,\n.\nThanks', html: '<p>Hi Jo</p>', messageId: newMessageId('me@acme.test') });
  await smtp.sendMail({ host: '127.0.0.1', port: f.port, user: 'me@acme.test', pass: 'apppass', from: 'me@acme.test', to: 'jo@client.test', raw, insecure: true });
  assert.strictEqual(f.received.length, 1);
  assert.match(f.received[0].to, /jo@client.test/);
  const parsed = parseMessage(f.received[0].data);
  assert.strictEqual(parsed.subject, 'Hello – café');
  assert.strictEqual(parsed.text.split('\n')[1], '.');
  f.server.close();
});

test('SMTP client reports a wrong password clearly', async () => {
  const f = await fakeSmtp();
  await assert.rejects(
    smtp.sendMail({ host: '127.0.0.1', port: f.port, user: 'me@acme.test', pass: 'wrong', from: 'me@acme.test', to: 'x@y.test', raw: 'Subject: x\r\n\r\nhi', insecure: true }),
    /Login failed/);
  f.server.close();
});

test('IMAP client: first poll only records position, later polls fetch new mail', async () => {
  const reply = 'From: Jo <jo@client.test>\r\nSubject: Re: Hello\r\nMessage-ID: <r1@client.test>\r\nIn-Reply-To: <abc@acme.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSounds good, give me a call.\r\n\r\nOn Mon, Alex wrote:\r\n> Hi Jo';
  const f = await fakeImap([reply, reply.replace('r1@', 'r2@')]);
  const opts = { host: '127.0.0.1', port: f.port, user: 'me@acme.test', pass: 'apppass', insecure: true };
  const first = await imap.fetchNew(opts, { lastUid: 0 });
  assert.strictEqual(first.messages.length, 0);
  assert.strictEqual(first.lastUid, 12);
  const second = await imap.fetchNew(opts, { lastUid: 10, uidValidity: '777' });
  assert.strictEqual(second.messages.length, 1);
  assert.strictEqual(second.lastUid, 11);
  const p = parseMessage(second.messages[0].raw);
  assert.strictEqual(p.from, 'jo@client.test');
  assert.strictEqual(p.inReplyTo, '<abc@acme.test>');
  assert.strictEqual(p.reply, 'Sounds good, give me a call.');
  await assert.rejects(imap.fetchNew({ ...opts, pass: 'nope' }, { lastUid: 1 }), /Login failed/);
  f.server.close();
});

test('MIME parser reads multipart, quoted-printable and encoded headers', () => {
  const raw = [
    'From: =?UTF-8?B?U8OpYmFzdGllbg==?= <seb@x.test>',
    'Subject: =?UTF-8?Q?Caf=C3=A9_question?=',
    'Content-Type: multipart/alternative; boundary="b1"',
    '', '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'Yes please, send the details =E2=80=93 thanks', '--b1', 'Content-Type: text/html', '', '<p>html</p>', '--b1--'
  ].join('\r\n');
  const p = parseMessage(raw);
  assert.strictEqual(p.subject, 'Café question');
  assert.strictEqual(p.fromRaw.startsWith('Sébastien'), true);
  assert.strictEqual(p.text, 'Yes please, send the details – thanks');
});
