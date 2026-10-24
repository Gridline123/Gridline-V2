'use strict';
// Compliance guard: the checks that make Gridline.io safe for UK/EU outreach.
const { normEmail, domainOf, isEmail, isPersonalEmail } = require('./util');

/** Things a workspace must have before any campaign can start. */
function workspaceProblems(ws) {
  const p = [];
  if (!String(ws.business_name || '').trim()) p.push('Add your business name (Settings → Compliance).');
  if (!String(ws.business_address || '').trim()) p.push('Add your business address (Settings → Compliance).');
  if (!String(ws.opt_out_text || '').trim()) p.push('Add an opt-out line (Settings → Compliance).');
  if (!/^https?:\/\//i.test(String(ws.privacy_url || ''))) p.push('Add a link to your privacy notice (Settings → Compliance).');
  return p;
}

/** Things a campaign must have before it can launch. */
function campaignProblems(campaign, steps, inboxes) {
  const p = [];
  if (!steps.length) p.push('Add at least one step.');
  const firstEmail = steps.find((s) => s.type === 'email');
  if (!firstEmail) p.push('Add at least one email step.');
  else if (!String(firstEmail.subject || '').trim()) p.push('The first email needs a subject.');
  steps.forEach((s) => { if (!String(s.body || '').trim()) p.push(`Step ${s.position} is empty.`); });
  if (!inboxes.length) p.push('Choose at least one sending inbox.');
  if (!String(campaign.lia_purpose || '').trim() || !String(campaign.lia_relevance || '').trim() || !String(campaign.lia_balance || '').trim()) {
    p.push('Complete the legitimate interest check (why you are contacting these people).');
  }
  if (!String(campaign.days || '').trim()) p.push('Choose at least one sending day.');
  if (Number(campaign.end_hour) <= Number(campaign.start_hour)) p.push('Sending hours: the end must be after the start.');
  return p;
}

function isSuppressed(db, wsId, email) {
  const e = normEmail(email);
  return !!db.get('SELECT 1 FROM suppression WHERE workspace_id = ? AND value IN (?, ?)', wsId, e, domainOf(e));
}

/** Why this lead can't be emailed (empty string = fine). */
function leadBlockReason(db, ws, lead) {
  if (!isEmail(lead.email)) return "The email address doesn't look valid.";
  if (isSuppressed(db, ws.id, lead.email)) return 'On your Do Not Contact list.';
  if (['opted_out', 'bounced'].includes(lead.status)) return 'This person has opted out or bounced.';
  if (isPersonalEmail(lead.email) && !lead.consent) {
    return 'Personal email address: UK rules need their prior consent before marketing emails. Tick "Has consented" on the lead if they have.';
  }
  if (!String(lead.source || '').trim()) return 'Record where you got this contact (the Source field). It goes in the privacy line of the first email.';
  return '';
}

function suppress(db, wsId, value, reason, actor) {
  const v = normEmail(value).replace(/^@/, '');
  if (!v) return;
  db.run('INSERT OR IGNORE INTO suppression (workspace_id, value, reason, created_at) VALUES (?,?,?,?)', wsId, v, reason, Date.now());
  db.audit(wsId, actor || 'system', 'suppressed', v, reason);
}

module.exports = { workspaceProblems, campaignProblems, leadBlockReason, isSuppressed, suppress };
