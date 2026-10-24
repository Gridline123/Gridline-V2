'use strict';
// Griddy: the in-app helper. Works for free from a built-in guide plus a live check
// of the user's own account. If GRIDDY_API_KEY (an Anthropic API key) is set, Griddy
// uses Claude for fuller answers; only counts and setup status are shared with it,
// never lead names, emails or message contents.
const C = require('./compliance');

const GUIDE = [
  { k: 'start begin setup first new how use getting started', a: 'Getting started takes about 10 minutes:\n1. Settings → Compliance: add your business name, address and privacy link.\n2. Settings → Inboxes: connect the email account you send from.\n3. Leads → Import CSV.\n4. Campaigns → New campaign: edit the steps, fill in the Legitimate interest tab, add your leads, send yourself a test, then Launch.' },
  { k: 'connect inbox gmail app password google workspace mailbox add', a: 'To connect Gmail or Google Workspace:\n1. Turn on 2-Step Verification on the Google account.\n2. Go to myaccount.google.com/apppasswords and create an app password called "Gridline.io".\n3. In Settings → Inboxes → Connect an inbox, choose Gmail and paste the 16-character password.\nOn Workspace, your admin may need to allow app passwords.' },
  { k: 'outlook microsoft 365 hotmail office', a: 'Outlook and Microsoft 365 aren\'t supported yet, because Microsoft has switched off app passwords for most accounts. Gmail, Google Workspace, Zoho, Fastmail and any provider with SMTP/IMAP app passwords work today.' },
  { k: 'not sending why stuck held emails sent nothing waiting', a: 'Emails only go out when: your compliance details are complete, the campaign is Running, an inbox is connected and has capacity today, and it\'s inside the campaign\'s sending days and hours. Leads are held if a name is missing, a merge field is broken, or it\'s a personal address without consent. Check the campaign\'s Leads tab to see why a lead is held.' },
  { k: 'merge field fields personalise personalize variable spintax random fallback', a: 'Use merge fields like {{FirstName}}, {{Company}} or any CSV column. Add a fallback with {{City|your area}}. Vary wording with {{random: Hi | Hello | Morning}}. If a field is missing and has no fallback, the email is held rather than sent wrong.' },
  { k: 'held blocked missing name merge field firstname', a: 'A lead is held when the email would go out wrong, for example an empty {{FirstName}} or a field that doesn\'t exist. Open the lead on the Leads page, fill in the missing detail, and it will send at the next check.' },
  { k: 'personal gmail hotmail consent sole trader blocked', a: 'Personal addresses (like Gmail or Hotmail) usually belong to individuals or sole traders, and UK PECR rules say you need their consent before sending marketing email. Gridline.io holds these unless you tick that you have consent on the lead.' },
  { k: 'limit daily ramp warm up how many per day spam junk deliverability inbox placement spf dkim dmarc', a: 'Each inbox starts slowly and builds up (the first-day limit, rising each day up to the daily limit). Around 30 a day per inbox is a safe ceiling. To land in inboxes rather than junk: set up SPF, DKIM and DMARC on your domain, keep emails short and plain, avoid links in the first email, and don\'t use your main domain for high volumes.' },
  { k: 'subject line write writing copy wording template tips reply rate first message opener', a: 'Tips for emails that get replies:\n• Keep subject lines short and plain, 2–4 words, like "Quick question" or "{{Company}} and [topic]".\n• Keep the first email under 100 words: one line about them, one line about what you do, one easy question.\n• Ask for a short reply, not a meeting.\n• Follow up 2–3 times, a few days apart, and add a call step after the first email.\n• Use Growth signals to open with something relevant, like a role they\'re hiring for.' },
  { k: 'call calls phone ring script task', a: 'Call steps in a sequence add the lead to your Calls page on the right day, with their number and a script. Log the outcome with one click: interested, call back, voicemail, not interested and so on. The sequence then carries on or stops for you.' },
  { k: 'reply replies inbox interested label stop', a: 'Gridline.io checks your inbox every few minutes. When someone replies, their sequence stops, the reply is labelled (interested, question, not interested, opted out or out of office) and a call-back task is created. Out-of-office replies don\'t stop the sequence. You can reply from the Replies page in the same thread.' },
  { k: 'unsubscribe opt out remove do not contact suppression dnc', a: 'Every email has a one-click unsubscribe link and your opt-out line. Unsubscribes, "please remove me" replies, bounces and erasure requests are added to the Do Not Contact list automatically, and that list is shared across every campaign. You can add emails or whole domains in Settings → Do Not Contact.' },
  { k: 'gdpr pecr legal law compliant ico legitimate interest lia', a: 'For emailing UK companies, PECR allows B2B marketing email to corporate addresses with an opt-out, and UK GDPR needs a lawful basis, usually legitimate interest. Gridline.io helps by requiring your business details, adding opt-out and privacy lines, recording a legitimate interest check per campaign, blocking personal addresses without consent and keeping an audit log. It\'s a tool, not legal advice, so check anything unusual with the ICO\'s guidance.' },
  { k: 'erase erasure delete forget data subject access sar retention', a: 'To handle an erasure request, open the lead and choose Erase. Their details are deleted and their email is kept only on the Do Not Contact list so you never contact them again. Inactive leads are deleted automatically after the number of months set in Settings → Compliance.' },
  { k: 'tps ctps telephone preference', a: 'Before cold calling, check numbers against TPS and CTPS (the Telephone Preference Services). Calling a registered number for marketing breaks PECR unless they\'ve agreed to hear from you. Gridline.io doesn\'t screen numbers yet.' },
  { k: 'import csv leads upload spreadsheet columns', a: 'Go to Leads → Import CSV, choose your file, match each column (email, first name, company and so on) and say where the contacts came from. The source is shown in the privacy line of the first email. Duplicates and Do Not Contact entries are skipped.' },
  { k: 'signals hiring adzuna jobs growth', a: 'Growth signals finds companies advertising jobs right now, a good sign they\'re growing. Get a free App ID and Key at developer.adzuna.com, add them in Settings → Growth signals, then search by job title and area. Each company can become a lead with a ready-made opening line.' },
  { k: 'test preview send test before launch', a: 'In a campaign, the Preview tab shows each email exactly as a real lead will see it, including the footer. Use "Send test to me" to get a copy in your own inbox before you launch.' },
  { k: 'pause stop campaign edit change', a: 'Pause a campaign at any time from its page. Nothing sends while it\'s paused, and it carries on from where each lead was when you resume. You can edit steps while paused.' },
  { k: 'dark mode light theme display colour color', a: 'Change the look in Settings → Display. Choose Light, Dark, or Match my device.' },
  { k: 'audit log export record', a: 'Settings → Audit log keeps a record of every email sent, opt-out, consent change, erasure and launch. Download it as a CSV any time.' },
  { k: 'bounce bounced invalid address', a: 'Bounced addresses are added to Do Not Contact automatically and the lead is marked Bounced. A high bounce rate harms your sending reputation, so check new lists before importing.' },
  { k: 'time zone timezone hours days schedule when', a: 'Each campaign has sending days and hours on its Schedule tab, using your workspace time zone (Settings → Compliance). Emails are spaced a few minutes apart so they look natural.' },
  { k: 'password forgot forgotten reset locked login log sign', a: 'Password reset by email is coming soon. For now, if you\'re locked out, contact the person who runs your Gridline.io account.' }
];

const STOP = new Set('a an the is are do does i my me to of and or in on for how what why can it be with this that you your get when where will whats email emails mail gridline io good best use using account check problem problems issue issues'.split(' '));
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));

function search(q) {
  const qw = words(q);
  return GUIDE.map((g) => {
    const kw = g.k.split(' ');
    const score = qw.reduce((s, w) => s + (kw.some((k) => k === w || (w.length > 3 && (k.startsWith(w) || w.startsWith(k)))) ? 1 : 0), 0);
    return { g, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
}

// A plain-English check of the user's own workspace.
function diagnose(db, engine, ws) {
  const out = [];
  const problems = C.workspaceProblems(ws);
  for (const p of problems) out.push(p);
  const inboxes = db.all('SELECT * FROM inboxes WHERE workspace_id = ?', ws.id);
  if (!inboxes.length) out.push('No inbox is connected yet (Settings → Inboxes).');
  for (const i of inboxes) {
    if (i.status === 'error') out.push(`Inbox ${i.email} needs reconnecting: ${i.last_error || 'login failed'}.`);
    else if (i.status === 'paused') out.push(`Inbox ${i.email} is paused.`);
    else {
      const sent = engine.sentToday(i, ws.timezone), lim = engine.limitToday(i);
      if (sent >= lim) out.push(`Inbox ${i.email} has reached today's limit (${sent}/${lim}). It sends again tomorrow.`);
    }
  }
  const camps = db.all('SELECT * FROM campaigns WHERE workspace_id = ?', ws.id);
  const running = camps.filter((c) => c.status === 'running');
  if (!camps.length) out.push('No campaigns yet (Campaigns → New campaign).');
  else if (!running.length) out.push(`No campaign is running (${camps.length} in draft or paused).`);
  for (const c of running) {
    const ce = { ...c, tz: ws.timezone };
    if (!engine.inWindow(ce, ws.timezone)) out.push(`"${c.name}" is outside its sending hours right now, so it will wait until its next sending window.`);
    const held = db.get(`SELECT COUNT(*) n FROM enrollments WHERE campaign_id = ? AND status = 'blocked'`, c.id).n;
    if (held) out.push(`"${c.name}" has ${held} lead${held === 1 ? '' : 's'} held. Open the campaign's Leads tab to see why.`);
    const linked = db.get('SELECT COUNT(*) n FROM campaign_inboxes WHERE campaign_id = ?', c.id).n;
    if (!linked) out.push(`"${c.name}" has no inbox chosen on its Schedule tab.`);
    const waiting = db.get(`SELECT COUNT(*) n FROM enrollments WHERE campaign_id = ? AND status IN ('queued','active')`, c.id).n;
    if (!waiting) out.push(`"${c.name}" has no leads waiting to be contacted.`);
  }
  return out;
}

const GREET = /^(hi|hey|hello|hiya|yo|morning|afternoon|evening|good (morning|afternoon|evening))\b[!. ]*$/i;
const ACCOUNT_Q = /\b(my|account|why|not|isn.?t|aren.?t|stuck|wrong|problem|issue|check|working|sending|sent)\b/i;

function localAnswer(question, facts) {
  if (GREET.test(question.trim())) return 'Hi! I\'m Griddy. Ask me anything about Gridline.io, for example "why aren\'t my emails sending?" or "how do I connect Gmail?"';
  const hits = search(question);
  const parts = [];
  const checking = ACCOUNT_Q.test(question) && /send|sent|work|stuck|wrong|problem|issue|check|held|launch/i.test(question);
  if (checking) {
    parts.push(facts.length ? 'I checked your account. Here\'s what I found:\n• ' + facts.join('\n• ') : 'I checked your account and everything looks set up: details complete, inbox connected and campaigns running. Emails go out during each campaign\'s sending hours, a few minutes apart.');
  }
  if (hits.length) parts.push(hits[0].g.a);
  if (!parts.length) return 'I\'m not sure about that one. Try asking about connecting an inbox, campaigns, merge fields, calls, replies, unsubscribes, compliance or growth signals. You can also ask "check my account" and I\'ll look for anything stopping emails going out.';
  return parts.join('\n\n');
}

function systemPrompt(ws, facts, page) {
  return `You are Griddy, the friendly helper inside Gridline.io, a UK web app for cold email + phone outreach. Answer questions about using the app, email deliverability, and UK/EU outreach rules (PECR, UK GDPR) clearly and briefly in British English. Use short paragraphs or numbered steps, plain text only (no markdown headers or tables). Point to exact places in the app, e.g. "Settings → Inboxes". If unsure, say so. On legal questions, give general information and note it isn't legal advice. Never invent features. Never help send email to people who opted out or to personal addresses without consent.

HOW GRIDLINE.IO WORKS:
${GUIDE.map((g) => '- ' + g.a.replace(/\n/g, ' ')).join('\n')}

THIS USER'S ACCOUNT RIGHT NOW (workspace "${ws.name}", time zone ${ws.timezone}, page: ${page || 'unknown'}):
${facts.length ? facts.map((f) => '- ' + f).join('\n') : '- No problems found: details complete, inbox connected, campaigns running.'}`;
}

async function aiAnswer({ apiKey, model, ws, facts, page, history, fetchImpl = fetch }) {
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 600, system: systemPrompt(ws, facts, page), messages: history }),
    signal: AbortSignal.timeout(25000)
  });
  if (!res.ok) throw new Error('AI request failed: ' + res.status);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

module.exports = { GUIDE, search, diagnose, localAnswer, aiAnswer, systemPrompt };
