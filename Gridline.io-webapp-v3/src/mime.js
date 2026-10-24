'use strict';
// Building outgoing emails and reading incoming ones (no libraries).
const { randomToken, domainOf } = require('./util');

const ASCII = /^[\x20-\x7e]*$/;

function encodeWord(s) {
  s = String(s ?? '');
  return ASCII.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

function wrap76(b64) { return b64.replace(/(.{76})/g, '$1\r\n'); }

function address(name, email) {
  const n = String(name || '').replace(/["\r\n]/g, '');
  if (!n) return `<${email}>`;
  return (ASCII.test(n) ? `"${n}"` : encodeWord(n)) + ` <${email}>`;
}

function newMessageId(fromEmail) {
  return `<${randomToken(16)}@${domainOf(fromEmail) || 'gridline.io'}>`;
}

function rfc2822Date(d = new Date()) {
  return d.toUTCString().replace('GMT', '+0000');
}

/**
 * m: { fromName, fromEmail, to, subject, text, html, messageId, inReplyTo, references,
 *      unsubscribeUrl, unsubscribeMailto }
 */
function buildMessage(m) {
  const boundary = 'gl_' + randomToken(12);
  const h = [
    'From: ' + address(m.fromName, m.fromEmail),
    'To: ' + m.to,
    'Subject: ' + encodeWord(m.subject).replace(/[\r\n]/g, ' '),
    'Date: ' + rfc2822Date(),
    'Message-ID: ' + m.messageId,
    'MIME-Version: 1.0'
  ];
  if (m.inReplyTo) h.push('In-Reply-To: ' + m.inReplyTo);
  if (m.references) h.push('References: ' + m.references);
  const unsub = [];
  if (m.unsubscribeUrl) unsub.push(`<${m.unsubscribeUrl}>`);
  if (m.unsubscribeMailto) unsub.push(`<${m.unsubscribeMailto}>`);
  if (unsub.length) h.push('List-Unsubscribe: ' + unsub.join(', '));
  if (m.unsubscribeUrl) h.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  h.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type, body) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    wrap76(Buffer.from(body, 'utf8').toString('base64')) + '\r\n';
  return h.join('\r\n') + '\r\n\r\n' + part('text/plain', m.text) + part('text/html', m.html) + `--${boundary}--\r\n`;
}

/* ---------------- parsing incoming mail ---------------- */

function decodeWords(s) {
  return String(s || '').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g, (m, cs, enc, txt) => {
    try {
      const buf = enc.toUpperCase() === 'B'
        ? Buffer.from(txt, 'base64')
        : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (x, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1');
      return decodeCharset(buf, cs);
    } catch (e) { return txt; }
  });
}

function decodeCharset(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '');
  try { return new TextDecoder(cs === 'us-ascii' ? 'utf-8' : cs).decode(buf); } catch (e) { return buf.toString('utf8'); }
}

function splitHeaderBody(buf) {
  const s = buf.toString('latin1');
  let idx = s.indexOf('\r\n\r\n'), sep = 4;
  if (idx === -1) { idx = s.indexOf('\n\n'); sep = 2; }
  if (idx === -1) return { head: s, body: Buffer.alloc(0) };
  return { head: s.slice(0, idx), body: buf.subarray(idx + sep) };
}

function parseHeaders(head) {
  const out = {};
  const lines = String(head).replace(/\r\n/g, '\n').split('\n');
  let cur = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) { out[cur] += ' ' + line.trim(); continue; }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    cur = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    out[cur] = out[cur] !== undefined ? out[cur] + ', ' + val : val;
  }
  return out;
}

function param(value, name) {
  const m = String(value || '').match(new RegExp(name + '\\s*=\\s*("([^"]*)"|[^;\\s]+)', 'i'));
  return m ? (m[2] !== undefined ? m[2] : m[1]) : '';
}

function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc === 'base64') return Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') {
    const s = buf.toString('latin1').replace(/=\r?\n/g, '');
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.substr(i + 1, 2))) { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
      else bytes.push(s.charCodeAt(i) & 0xff);
    }
    return Buffer.from(bytes);
  }
  return buf;
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Returns the best plain-text body found in a (possibly multipart) message. */
function extractText(headers, body, depth = 0) {
  const type = String(headers['content-type'] || 'text/plain').toLowerCase();
  if (type.startsWith('multipart/') && depth < 5) {
    const boundary = param(headers['content-type'], 'boundary');
    if (!boundary) return '';
    const parts = body.toString('latin1').split('--' + boundary);
    let plain = '', html = '';
    for (const p of parts.slice(1)) {
      if (p.startsWith('--')) break;
      const pb = Buffer.from(p.replace(/^\r?\n/, ''), 'latin1');
      const { head, body: b } = splitHeaderBody(pb);
      const ph = parseHeaders(head);
      const pt = String(ph['content-type'] || 'text/plain').toLowerCase();
      if (pt.startsWith('multipart/')) { const t = extractText(ph, b, depth + 1); if (t && !plain) plain = t; continue; }
      if (/attachment/i.test(ph['content-disposition'] || '')) continue;
      const text = decodeCharset(decodeBody(b, ph['content-transfer-encoding']), param(ph['content-type'], 'charset'));
      if (pt.startsWith('text/plain') && !plain) plain = text;
      else if (pt.startsWith('text/html') && !html) html = text;
      else if (pt.startsWith('message/delivery-status') && !plain) plain = text;
    }
    return plain || (html ? htmlToText(html) : '');
  }
  const text = decodeCharset(decodeBody(body, headers['content-transfer-encoding']), param(headers['content-type'], 'charset'));
  return type.startsWith('text/html') ? htmlToText(text) : text;
}

/** Removes the quoted earlier conversation from a reply. */
function stripQuoted(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) break;
    if (/^On .+wrote:\s*$/i.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())) break;
    if (/^From:\s.+/i.test(line.trim()) && out.length > 0) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

function emailFrom(value) {
  const m = String(value || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(value || '').split(/[\s,]/).find((x) => x.includes('@')) || '').trim().toLowerCase();
}

function parseMessage(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'latin1');
  const { head, body } = splitHeaderBody(buf);
  const h = parseHeaders(head);
  const text = extractText(h, body).replace(/\r\n/g, "\n").trim();
  return {
    headers: h,
    from: emailFrom(h.from),
    fromRaw: decodeWords(h.from || ''),
    subject: decodeWords(h.subject || ''),
    messageId: (String(h['message-id'] || '').match(/<[^>]+>/) || [''])[0],
    inReplyTo: (String(h['in-reply-to'] || '').match(/<[^>]+>/) || [''])[0],
    references: String(h.references || '').match(/<[^>]+>/g) || [],
    text,
    reply: stripQuoted(text)
  };
}

module.exports = { buildMessage, newMessageId, parseMessage, decodeWords, stripQuoted, emailFrom, htmlToText };
