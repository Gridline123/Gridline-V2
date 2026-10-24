'use strict';
// Turns a step template + a lead into a ready-to-send email (or call script).
const { escapeHtml } = require('./util');

function key(s) { return String(s).replace(/[^A-Za-z0-9]/g, '').toLowerCase(); }

function fieldsFor(lead, inbox) {
  const f = {
    firstname: lead.first_name, lastname: lead.last_name, company: lead.company, jobtitle: lead.title,
    title: lead.title, phone: lead.phone, website: lead.website, personalline: lead.personal_line,
    source: lead.source, email: lead.email
  };
  let custom = {};
  try { custom = JSON.parse(lead.custom_json || '{}'); } catch (e) { custom = {}; }
  for (const [k, v] of Object.entries(custom)) f[key(k)] = v;
  if (inbox) {
    f.sendername = inbox.from_name;
    f.senderfirstname = String(inbox.from_name || '').split(' ')[0];
    f.senderemail = inbox.email;
  }
  for (const k of Object.keys(f)) f[k] = String(f[k] ?? '').trim();
  return f;
}

/**
 * Supports {{FirstName}}, {{Company|your team}} (fallback) and {{random: Hi | Hello}}.
 * Returns { text, errors }.
 */
function merge(template, fields, rng = Math.random) {
  const errors = [];
  const out = String(template || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, inner) => {
    if (/^random\s*:/i.test(inner)) {
      const opts = inner.replace(/^random\s*:/i, '').split('|').map((s) => s.trim()).filter(Boolean);
      return opts.length ? opts[Math.floor(rng() * opts.length)] : '';
    }
    const [name, ...fb] = inner.split('|');
    const k = key(name);
    const fallback = fb.length ? fb.join('|').trim() : null;
    if (!Object.prototype.hasOwnProperty.call(fields, k)) {
      if (fallback !== null) return fallback;
      errors.push(`"${name.trim()}" isn't a field on this lead`);
      return m;
    }
    const v = fields[k];
    if (!v) {
      if (fallback !== null) return fallback;
      if (k === 'firstname' || k === 'company') errors.push(`${name.trim()} is empty`);
      return '';
    }
    return v;
  });
  const text = out.replace(/[ \t]+\n/g, '\n').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, errors };
}

function paragraphs(text) {
  return String(text).split(/\n{2,}/).map((p) =>
    '<p style="margin:0 0 14px 0">' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('');
}

function complianceFooter(ws, lead, unsubscribeUrl, first) {
  const id = [ws.business_name, ws.company_number ? 'Company no. ' + ws.company_number : '', ws.business_address]
    .filter(Boolean).join(' · ');
  const lines = [];
  lines.push(ws.opt_out_text + (unsubscribeUrl ? ' Or unsubscribe here: ' + unsubscribeUrl : ''));
  if (first && lead.source) {
    lines.push(`We found your business details via ${lead.source}.` + (ws.privacy_url ? ` How we use them: ${ws.privacy_url}` : ''));
  } else if (ws.privacy_url) {
    lines.push('Privacy notice: ' + ws.privacy_url);
  }
  if (id) lines.push(id);
  const text = lines.join('\n');
  const html = '<div style="margin-top:22px;padding-top:10px;border-top:1px solid #e3e7ec;color:#8a94a3;font-size:11px;line-height:1.5">' +
    lines.map((l) => escapeHtml(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#8a94a3">$1</a>')).join('<br>') + '</div>';
  return { text, html };
}

function renderEmail({ ws, lead, inbox, step, firstEmail, unsubscribeUrl, rng }) {
  const fields = fieldsFor(lead, inbox);
  const body = merge(step.body, fields, rng);
  const subj = merge(step.subject, fields, rng);
  const errors = [...new Set([...body.errors, ...subj.errors])];
  if (!body.text) errors.push('the email body is empty');
  const sig = inbox && inbox.signature ? String(inbox.signature).trim() : '';
  const foot = complianceFooter(ws, lead, unsubscribeUrl, firstEmail);
  const text = body.text + (sig ? '\n\n' + sig : '') + '\n\n' + foot.text;
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1c2a3d">' +
    paragraphs(body.text) + (sig ? paragraphs(sig) : '') + foot.html + '</div>';
  return { subject: subj.text, bodyText: body.text, text, html, errors };
}

function renderScript(step, lead, inbox) {
  return merge(step.body, fieldsFor(lead, inbox)).text;
}

module.exports = { merge, fieldsFor, renderEmail, renderScript, complianceFooter, key };
