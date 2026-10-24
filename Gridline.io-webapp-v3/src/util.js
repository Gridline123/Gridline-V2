'use strict';
const crypto = require('node:crypto');

/* ---------- secrets ---------- */

function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('base64') + '$' + key.toString('base64');
}

function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const key = crypto.scryptSync(String(pw), salt, expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}

let encKey = null;
function setSecret(secret) {
  if (!secret || String(secret).length < 16) throw new Error('APP_SECRET must be at least 16 characters.');
  encKey = crypto.scryptSync(String(secret), 'gridline-io-inbox-key', 32);
}

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  const [iv, tag, data] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/* ---------- time ---------- */

function zoned(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), dow };
}

function dayKey(ts, tz) { return zoned(ts, tz).day; }

/* ---------- email ---------- */

const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com',
  'live.com', 'live.co.uk', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aol.co.uk', 'btinternet.com', 'sky.com', 'talktalk.net', 'virginmedia.com', 'ntlworld.com',
  'blueyonder.co.uk', 'tiscali.co.uk', 'protonmail.com', 'proton.me', 'gmx.com', 'gmx.co.uk', 'mail.com', 'zoho.com']);

function normEmail(e) { return String(e || '').trim().toLowerCase(); }
function domainOf(e) { const s = normEmail(e); return s.includes('@') ? s.split('@').pop() : ''; }
function isEmail(e) { return /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i.test(String(e || '').trim()); }
function isPersonalEmail(e) { return PERSONAL_DOMAINS.has(domainOf(e)); }

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- CSV ---------- */

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function toCsv(rows) {
  return rows.map((r) => r.map((v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

module.exports = {
  randomToken, sha256, hashPassword, verifyPassword, setSecret, encrypt, decrypt,
  zoned, dayKey, normEmail, domainOf, isEmail, isPersonalEmail, escapeHtml, parseCsv, toCsv, PERSONAL_DOMAINS
};
