// Gridline.io web app – plain JavaScript, no framework.

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const raw = (s) => ({ __html: String(s) });
function val(v) {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(val).join('');
  if (typeof v === 'object' && '__html' in v) return v.__html;
  return esc(v);
}
function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s + (i < vals.length ? val(vals[i]) : ''); });
  return raw(out);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', 'X-Gridline': '1' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 401 && !opts.allow401) { state.me = null; go('#/login'); throw new Error('Please log in.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
const post = (p, body = {}) => api(p, { method: 'POST', body });
const put = (p, body = {}) => api(p, { method: 'PUT', body });
const del = (p) => api(p, { method: 'DELETE', body: {} });

let toastTimer;
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 4200);
}

const pct = (n) => (Number.isFinite(n) ? n.toFixed(1) + '%' : '–');
const when = (ts) => ts ? new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const dayName = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
const fullName = (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email || '(no name)';
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(); };

const LEAD_STATUS = {
  new: ['New', ''], contacted: ['Contacted', 'b-blue'], replied: ['Replied', 'b-hot'], interested: ['Interested', 'b-good'],
  not_interested: ['Not interested', ''], opted_out: ['Opted out', ''], bounced: ['Bounced', 'b-bad'], wrong_person: ['Wrong person', '']
};
const ENR_STATUS = {
  queued: ['Waiting', ''], active: ['In sequence', 'b-blue'], replied: ['Replied', 'b-hot'], completed: ['Finished', ''],
  stopped: ['Stopped', ''], blocked: ['Held', 'b-bad'], paused: ['Paused', 'b-warn']
};
const LABELS = {
  interested: ['Interested', 'b-good'], question: ['Question', 'b-hot'], not_interested: ['Not interested', ''],
  opted_out: ['Opted out', ''], other: ['Replied', 'b-blue'], ooo: ['Out of office', 'b-warn']
};
const CAMP_STATUS = { draft: ['Draft', ''], running: ['Running', 'b-good'], paused: ['Paused', 'b-warn'], completed: ['Finished', ''] };
const badge = (map, k) => { const [t, c] = map[k] || [k, '']; return html`<span class="badge ${c}">${t}</span>`; };

/* ------------------------------------------------------------------ */
/* App state, routing and layout                                       */
/* ------------------------------------------------------------------ */

const state = { me: null };
const app = document.getElementById('app');
const NAV = [
  ['dashboard', 'Dashboard', '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'],
  ['calls', 'Calls', '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'],
  ['replies', 'Replies', '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v7H2v-7z"/>'],
  ['campaigns', 'Campaigns', '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'],
  ['leads', 'Leads', '<circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6"/><path d="M17 11h5M19.5 8.5v5"/>'],
  ['signals', 'Growth signals', '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>'],
  ['settings', 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>']
];

function shell(page, content) {
  const c = (state.me && state.me.counts) || {};
  const counts = { calls: c.calls, replies: c.replies };
  return html`<div class="shell">
<nav class="nav" aria-label="Main">
  <a class="brand" href="#/dashboard">Gridline<span>.io</span></a>
  <div class="nav-links">${NAV.map(([k, label, icon]) => html`<a href="#/${k}" class="${page === k ? 'on' : ''}"${raw(page === k ? ' aria-current="page"' : '')}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${raw(icon)}</svg>${label}${counts[k] ? html`<span class="count">${counts[k]}</span>` : ''}</a>`)}</div>
  <div class="nav-foot"><span class="nav-clock"><span data-live="shortDate">${tzNow().shortDate}</span> · <span data-live="short">${tzNow().short}</span></span><strong>${state.me ? state.me.workspace.name : ''}</strong><span>${state.me ? state.me.user.email : ''}</span><button type="button" data-act="logout">Log out</button></div>
</nav>
<main class="main" id="main">${state.me && state.me.sandbox ? html`<div class="notice info small"><strong>Sandbox mode:</strong> everything works, but no real emails are sent or read.</div>` : ''}${planBanner()}${content}</main>
</div>`.__html;
}

function planBanner() {
  const p = state.me && state.me.plan;
  if (!p) return '';
  const owner = state.me.role === 'owner';
  const cta = owner ? html` <a class="btn small primary" href="#/settings/billing">${p.locked ? 'Choose a plan' : 'See plans'}</a>` : html` <span>Ask your account owner to upgrade.</span>`;
  if (p.locked) return html`<div class="plan-banner locked" role="status"><span><strong>Sending is paused.</strong> ${p.locked} Your leads, replies and settings are all kept.</span>${cta}</div>`;
  if (p.past_due) return html`<div class="plan-banner locked" role="status"><span><strong>Your last payment didn't go through.</strong> Update your card to avoid interruption.</span>${owner ? html` <button class="btn small primary" data-act="billingPortal">Update card</button>` : ''}</div>`;
  if (!p.paid) {
    const used = Math.min(100, p.emails_used / p.emails_limit * 100);
    return html`<div class="plan-banner"><span><strong>Free trial:</strong> ${p.trial_days_left} day${p.trial_days_left === 1 ? '' : 's'} left · ${p.emails_used} of ${p.emails_limit} emails used</span><span class="pb-bar" aria-hidden="true"><i style="width:${used}%"></i></span>${cta}</div>`;
  }
  return '';
}

async function refreshMe() {
  try { state.me = await api('/api/me', { allow401: true }); } catch (e) { state.me = null; }
  if (state.me) applyTheme(state.me.user.theme);
}

/* ---------- light / dark ---------- */

function applyTheme(t) {
  const theme = ['light', 'dark', 'system'].includes(t) ? t : 'system';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('gl_theme', theme); } catch (e) { /* storage blocked: still works for this visit */ }
}

/* ---------- live greeting and clock (in the workspace time zone) ---------- */

function tzNow() {
  const tz = (state.me && state.me.workspace.timezone) || undefined;
  const d = new Date();
  const opt = (o) => { try { return d.toLocaleString('en-GB', { ...o, timeZone: tz }); } catch (e) { return d.toLocaleString('en-GB', o); } };
  const hour = Number(opt({ hour: '2-digit', hourCycle: 'h23' }));
  return {
    hour,
    greet: hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening',
    time: opt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
    short: opt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    date: opt({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    shortDate: opt({ weekday: 'short', day: 'numeric', month: 'short' })
  };
}
const firstName = () => ((state.me && state.me.user.name) || '').trim().split(/\s+/)[0] || 'there';
function tick() {
  const n = tzNow();
  document.querySelectorAll('[data-live]').forEach((el) => {
    const v = el.dataset.live === 'greet' ? `${n.greet}, ${firstName()}` : n[el.dataset.live];
    if (el.textContent !== v) el.textContent = v;
  });
}
setInterval(tick, 1000);

const pages = {};
let currentPage = '';

async function render() {
  const hash = location.hash || '#/dashboard';
  const parts = hash.replace(/^#\//, '').split('/');
  const page = parts[0] || 'dashboard';
  if (page === 'login' || page === 'signup') { app.innerHTML = authPage(page).__html; griddyMount(false); return; }
  if (page === 'join') { griddyMount(false); app.innerHTML = (await joinPage(parts[1])).__html; return; }
  if (!state.me) { await refreshMe(); if (!state.me) { go('#/login'); return; } }
  griddyMount(true);
  currentPage = page;
  const fn = pages[page] || pages.dashboard;
  app.innerHTML = shell(page, html`<p class="muted">Loading…</p>`);
  try {
    const content = await fn(parts.slice(1));
    if (currentPage !== page) return;
    app.innerHTML = shell(page, content);
    tick();
    const h1 = app.querySelector('h1');
    if (h1) document.title = h1.textContent + ' · Gridline.io';
  } catch (e) {
    if (state.me) app.innerHTML = shell(page, html`<div class="error-box">${e.message}</div>`);
  }
}
const rerender = () => render();
window.addEventListener('hashchange', render);

/* ------------------------------------------------------------------ */
/* Event wiring: data-act (click), data-form (submit)                  */
/* ------------------------------------------------------------------ */

const acts = {};
const forms = {};
const changes = {};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !acts[el.dataset.act]) return;
  e.preventDefault();
  if (el.disabled) return;
  try { await acts[el.dataset.act](el, e); } catch (err) { toast(err.message, true); }
});
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f || !forms[f.dataset.form]) return;
  e.preventDefault();
  const btn = f.querySelector('[type=submit]');
  if (btn) btn.disabled = true;
  try { await forms[f.dataset.form](f, Object.fromEntries(new FormData(f))); }
  catch (err) { const box = f.querySelector('.form-error'); if (box) { box.textContent = err.message; box.hidden = false; } else toast(err.message, true); }
  finally { if (btn && document.body.contains(btn)) btn.disabled = false; }
});
document.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-change]');
  if (!el || !changes[el.dataset.change]) return;
  try { await changes[el.dataset.change](el, e); } catch (err) { toast(err.message, true); }
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-bind]');
  if (el && changes[el.dataset.bind]) changes[el.dataset.bind](el, e);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (document.getElementById('modal')) closeModal(); else if (griddy.open) griddyToggle(false); } });

/* ---------- modal ---------- */

function openModal(content) {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.id = 'modal';
  back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${val(content)}</div>`;
  back.addEventListener('click', (e) => { if (e.target === back) closeModal(); });
  document.body.appendChild(back);
  const first = back.querySelector('input, textarea, select, button');
  if (first) first.focus();
}
function closeModal() { const m = document.getElementById('modal'); if (m) m.remove(); }
acts.closeModal = () => closeModal();

let confirmFn = null;
function confirmBox(title, text, label, fn) {
  confirmFn = fn;
  openModal(html`<h2>${title}</h2><p>${text}</p><div class="row"><button class="btn primary" data-act="confirmYes">${label}</button><button class="btn" data-act="closeModal">Cancel</button></div>`);
}
acts.confirmYes = async () => { const f = confirmFn; confirmFn = null; closeModal(); if (f) await f(); };

/* ------------------------------------------------------------------ */
/* Login / sign up                                                     */
/* ------------------------------------------------------------------ */

function authPage(mode) {
  const signup = mode === 'signup';
  return html`<div class="auth"><form class="auth-box" data-form="${signup ? 'signup' : 'login'}">
  <span class="brand">Gridline<span style="color:var(--orange)">.io</span></span>
  <p class="auth-pitch">Find growing businesses, email them safely and know who to ring every morning.</p>
  <h1 style="font-size:22px">${signup ? 'Create your account' : 'Log in'}</h1>
  <div class="error-box form-error" hidden></div>
  ${signup ? html`<label class="field">Your name<input type="text" name="name" autocomplete="name" required></label>
  <label class="field">Business name<input type="text" name="company" autocomplete="organization"></label>` : ''}
  <label class="field">Email<input type="email" name="email" autocomplete="email" required></label>
  <label class="field">Password${signup ? html`<span class="hint">At least 10 characters</span>` : ''}<input type="password" name="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="${signup ? 10 : 1}" required></label>
  <button class="btn primary" type="submit">${signup ? 'Create account' : 'Log in'}</button>
  <p class="small muted" style="margin:0">${signup ? html`Already have an account? <a href="#/login">Log in</a>` : html`New here? <a href="#/signup">Create an account</a>`}</p>
</form></div>`;
}
forms.login = async (f, d) => { await post('/api/login', d); await refreshMe(); go('#/dashboard'); };
forms.signup = async (f, d) => { await post('/api/signup', d); await refreshMe(); go('#/settings/compliance'); toast('Welcome! Start by adding your business details.'); };
acts.logout = async () => { await post('/api/logout'); state.me = null; go('#/login'); };

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

pages.dashboard = async () => {
  const [d] = await Promise.all([api('/api/dashboard'), refreshMe()]);
  const max = Math.max(1, ...d.days.map((x) => x.sent));
  const now = tzNow();
  const g = d.guard;
  const setupSteps = [
    [g.problems.length === 0, 'Add your business and privacy details', '#/settings/compliance'],
    [d.inboxes.length > 0, 'Connect an inbox to send from', '#/settings/inboxes'],
    [d.running > 0 || d.contacted > 0, 'Create and launch your first campaign', '#/campaigns']
  ];
  const setupLeft = setupSteps.filter((s) => !s[0]);
  return html`
<header class="page-head">
  <div><p class="eyebrow">Dashboard</p>
  <h1 data-live="greet">${now.greet}, ${firstName()}</h1></div>
  <div class="greet-time" aria-label="Current time"><span class="clock" data-live="time">${now.time}</span><span class="date" data-live="date">${now.date}</span></div>
</header>
<div class="row" style="margin-top:-8px">
    ${d.calls_total ? html`<a class="btn" href="#/calls">${d.calls_total} call${d.calls_total === 1 ? '' : 's'} to make</a>` : ''}
    <a class="btn primary" href="#/campaigns">Campaigns</a>
</div>

${setupLeft.length ? html`<section class="card"><h2>Get set up</h2><p class="sub">Three steps and Gridline.io will start working for you.</p>
<ol style="margin:10px 0 0;padding-left:20px;display:flex;flex-direction:column;gap:6px">${setupSteps.map(([ok, label, href]) => html`<li>${ok ? html`<s class="muted">${label}</s> <span class="badge b-good">Done</span>` : html`<a href="${href}">${label}</a>`}</li>`)}</ol></section>` : ''}

<section class="tiles" aria-label="At a glance">
  <div class="tile"><div class="k">Sent today</div><div class="v">${d.sent_today}</div><div class="n">of ${d.limit_today} allowed today</div><div class="bar"><i style="width:${Math.min(100, d.limit_today ? d.sent_today / d.limit_today * 100 : 0)}%"></i></div></div>
  <div class="tile"><div class="k">Reply rate, 30 days</div><div class="v">${d.contacted ? pct(d.reply_rate) : '–'}</div><div class="n">${d.replied} replies from ${d.contacted} people</div></div>
  <div class="tile"><div class="k">Interested this week</div><div class="v">${d.interested}</div><div class="n">by email or phone</div></div>
  <div class="tile"><div class="k">Bounce rate</div><div class="v">${d.contacted ? pct(d.bounce_rate) : '–'}</div><div class="n">${d.bounce_rate > 3 ? html`<span class="badge b-bad">Check your list</span>` : html`<span class="badge b-good">Healthy</span>`}</div></div>
</section>

<div class="grid-2">
  <section class="card">
    <div class="card-head"><h2>Calls due today</h2><a href="#/calls" class="small">Open call list →</a></div>
    ${d.calls.length ? html`<div class="list">${d.calls.map((c) => html`<div class="list-item row between"><div><strong>${fullName(c)}</strong> ${c.status === 'interested' ? html`<span class="badge b-good">Interested</span>` : c.status === 'replied' ? html`<span class="badge b-hot">Replied</span>` : ''}<div class="small muted">${[c.title, c.company].filter(Boolean).join(' · ')} · ${c.reason}</div></div><div class="num" style="font-weight:700;color:var(--steel)">${c.phone || html`<span class="muted small">No number</span>`}</div></div>`)}</div>`
      : html`<p class="empty">No calls today. Calls appear here when a sequence reaches a call step or someone replies.</p>`}
  </section>

  <section class="card">
    <div class="card-head"><h2>Emails and replies, last 14 days</h2><div class="legend"><span><i style="background:var(--chart-s)"></i>Sent</span><span><i style="background:var(--orange)"></i>Replies</span></div></div>
    <div class="chart" role="img" aria-label="${d.days.reduce((s, x) => s + x.sent, 0)} emails sent and ${d.days.reduce((s, x) => s + x.replies, 0)} replies in the last 14 days">
      ${d.days.map((x) => html`<div class="col" title="${dayName(x.day)}: ${x.sent} sent, ${x.replies} replies"><div class="s" style="height:${x.sent / max * 100}%"></div><div class="r" style="height:${x.replies / max * 100}%"></div></div>`)}
    </div>
    <div class="row between small muted" style="margin-top:6px"><span>${dayName(d.days[0].day)}</span><span>Today</span></div>
  </section>

  <section class="card">
    <div class="card-head"><h2>Safety guard</h2>${g.problems.length ? html`<span class="badge b-warn">Action needed</span>` : html`<span class="badge b-good">All clear</span>`}</div>
    <p class="sub small" style="margin-top:-4px">Every email is checked before it goes, so one bad list can't land you in trouble.</p>
    <div class="list" style="margin-top:8px">
      <div class="list-item row between"><span>Opt-out line, unsubscribe link and privacy notice on every email</span><span class="badge ${g.problems.length ? 'b-warn' : 'b-good'}">${g.problems.length ? 'Set up needed' : 'On'}</span></div>
      <div class="list-item row between"><span>Contacts held back for checks</span><a href="#/leads">${g.blocked} held</a></div>
      <div class="list-item row between"><span>Personal addresses (Gmail, Hotmail…) without consent</span><span class="num">${g.personal_held} held</span></div>
      <div class="list-item row between"><span>Do Not Contact list, shared by every campaign</span><a href="#/settings/dnc">${g.suppressed} entries</a></div>
    </div>
    ${g.problems.length ? html`<div class="notice" style="margin-top:10px">Before you can send:<ul>${g.problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
  </section>

  <section class="card">
    <div class="card-head"><h2>Sending inboxes</h2><a href="#/settings/inboxes" class="small">Manage →</a></div>
    ${d.inboxes.length ? html`<div class="stack">${d.inboxes.map((i) => html`<div><div class="row between"><strong>${i.email}</strong><span class="num muted">${i.sent_today} / ${i.limit_today} today</span></div>
      <div class="bar steel"><i style="width:${Math.min(100, i.sent_today / Math.max(1, i.limit_today) * 100)}%"></i></div>
      <div class="small" style="margin-top:4px;color:${i.status === 'active' ? 'var(--good)' : 'var(--bad)'}">${i.status === 'active' ? (i.limit_today < i.daily_limit ? `Warming up: limit rises to ${i.daily_limit} a day` : 'Running at full daily limit') : i.status === 'paused' ? 'Paused' : 'Needs attention: ' + (i.last_error || 'reconnect')}</div></div>`)}</div>`
      : html`<p class="empty">No inboxes yet. <a href="#/settings/inboxes">Connect one</a> to start sending.</p>`}
  </section>
</div>

${d.recent.length ? html`<section class="card"><div class="card-head"><h2>Latest replies</h2><a href="#/replies" class="small">All replies →</a></div><div class="list">${d.recent.map((r) => html`<div class="list-item"><div class="row between"><strong>${fullName(r)} <span class="muted small">${r.company}</span></strong>${badge(LABELS, r.label)}</div><div class="small" style="margin-top:2px">${String(r.body_text).slice(0, 160)}</div></div>`)}</div></section>` : ''}
<p class="small muted">Gridline.io checks for due emails every minute and for replies every few minutes. <button class="btn small" data-act="runNow">Check now</button></p>`;
};
acts.runNow = async (el) => { el.disabled = true; await post('/api/engine/run'); toast('Checked for replies and due emails.'); rerender(); };

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

let callsView = 'open';
pages.calls = async () => {
  const d = await api('/api/tasks?view=' + callsView);
  const outcomes = [['no_answer', 'No answer'], ['voicemail', 'Left voicemail'], ['interested', 'Interested'], ['not_now', 'Not now'], ['wrong_person', 'Wrong person'], ['do_not_contact', 'Do not contact']];
  return html`
<header class="page-head"><div><p class="eyebrow">Calls</p><h1>${callsView === 'open' ? `${d.rows.length} call${d.rows.length === 1 ? '' : 's'} to make` : 'Completed calls'}</h1>
<p class="sub">Hottest first: people who replied, then sequence call steps. Log the outcome and Gridline.io updates the sequence for you.</p></div>
<div class="row" role="group" aria-label="View"><button class="chip-btn" data-act="callsView" data-v="open" aria-pressed="${callsView === 'open'}">To do</button><button class="chip-btn" data-act="callsView" data-v="done" aria-pressed="${callsView === 'done'}">Done</button></div></header>
<section class="card">${d.rows.length ? html`<div class="list">${d.rows.map((t) => html`
<div class="call-card">
  <div><strong style="font-size:15px">${fullName(t)}</strong> ${badge(LEAD_STATUS, t.lead_status)}
    <div class="small muted">${[t.title, t.company].filter(Boolean).join(' · ')}</div>
    <div class="small" style="margin-top:2px">${t.reason}${t.due_day < d.today ? html` · <span style="color:var(--bad)">due ${dayName(t.due_day)}</span>` : ''}</div></div>
  <div class="phone">${t.phone ? html`<a href="tel:${t.phone.replace(/\s/g, '')}">${t.phone}</a>` : html`<span class="muted small">No number</span>`}<div class="small muted" style="font-weight:400">${t.email}</div></div>
  ${t.script ? html`<details class="script"><summary class="small" style="cursor:pointer">Call script</summary><div class="pre" style="margin-top:6px">${t.script}</div></details>` : ''}
  ${callsView === 'open' ? html`<label class="field script">Notes<input type="text" id="note-${t.id}" placeholder="Optional"></label>
  <div class="outcomes">${outcomes.map(([k, l]) => html`<button class="btn small ${k === 'interested' ? 'dark' : ''}" data-act="outcome" data-id="${t.id}" data-o="${k}">${l}</button>`)}</div>`
  : html`<div class="script small">Outcome: <strong>${String(t.outcome).replace(/_/g, ' ')}</strong>${t.notes ? ' – ' + t.notes : ''} · ${when(t.completed_at)}</div>`}
</div>`)}</div>` : html`<p class="empty">${callsView === 'open' ? 'Nothing to call right now.' : 'No completed calls yet.'}${d.upcoming ? ` ${d.upcoming} more coming up on later days.` : ''}</p>`}</section>`;
};
acts.callsView = (el) => { callsView = el.dataset.v; rerender(); };
acts.outcome = async (el) => {
  const notes = (document.getElementById('note-' + el.dataset.id) || {}).value || '';
  await post(`/api/tasks/${el.dataset.id}/outcome`, { outcome: el.dataset.o, notes });
  toast('Call logged.');
  await refreshMe(); re};

/* ------------------------------------------------------------------ */
/* Replies                                                             */
/* ------------------------------------------------------------------ */

let replyFilter = 'all', replyOpen = null;
pages.replies = async () => {
  const d = await api('/api/replies?label=' + replyFilter);
  if (!d.rows.find((r) => r.id === replyOpen)) replyOpen = d.rows[0] ? d.rows[0].id : null;
  const open = d.rows.find((r) => r.id === replyOpen);
  if (open && !open.is_read) { post(`/api/replies/${open.id}/read`).then(refreshMe); open.is_read = 1; }
  const filters = [['all', 'All'], ['interested', 'Interested'], ['question', 'Questions'], ['other', 'Other'], ['not_interested', 'Not interested'], ['opted_out', 'Opted out'], ['ooo', 'Out of office']];
  return html`
<header class="page-head"><div><p class="eyebrow">Replies</p><h1>Every reply, sorted for you</h1>
<p class="sub">Replies from all your inboxes. Gridline.io stops the sequence, labels the reply and adds a call-back where it makes sense.</p></div></header>
<div class="row" role="group" aria-label="Filter">${filters.map(([k, l]) => html`<button class="chip-btn" data-act="replyFilter" data-v="${k}" aria-pressed="${replyFilter === k}">${l}${d.counts[k] && k !== 'all' ? ` (${d.counts[k]})` : ''}</button>`)}</div>
${d.rows.length ? html`<div class="inbox">
  <section class="card thread-list" aria-label="Conversations">${d.rows.map((r) => html`<button class="thread-btn" data-act="openReply" data-id="${r.id}" aria-pressed="${r.id === replyOpen}">
    <span class="row between"><strong>${r.is_read ? '' : html`<span class="unread" aria-label="Unread"></span>`}${fullName(r)}</strong><span class="small muted">${when(r.created_at)}</span></span>
    <span class="small muted">${r.company}</span>
    <span class="row" style="gap:6px;flex-wrap:nowrap">${badge(LABELS, r.label)}<span class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${String(r.body_text).slice(0, 90)}</span></span></button>`)}</section>
  ${open ? html`<section class="card thread-view stack" aria-label="Conversation">
    <div class="row between"><div><h2 style="font-size:20px">${fullName(open)}</h2><div class="small muted">${[open.title, open.company, open.phone, open.lead_email].filter(Boolean).join(' · ')}</div></div>
    <label class="field" style="min-width:180px">Label<select data-change="relabel" data-id="${open.id}">${['interested', 'question', 'other', 'not_interested', 'opted_out'].map((k) => html`<option value="${k}" ${raw(open.label === k ? 'selected' : '')}>${LABELS[k][0]}</option>`)}</select></label></div>
    ${open.thread.map((m) => html`<div class="msg ${m.direction}"><div class="meta">${m.direction === 'out' ? 'You' : fullName(open)} · ${when(m.created_at)}${m.subject ? ' · ' + m.subject : ''}</div><div class="body">${m.body_text}</div></div>`)}
    <form data-form="sendReply" class="stack"><input type="hidden" name="id" value="${open.id}">
      <label class="field">Your reply<textarea name="body" rows="5" placeholder="Write a reply…" required></textarea></label>
      <div class="row"><button class="btn primary" type="submit">Send reply</button><span class="small muted">Sent from the inbox they replied to, in the same thread.</span></div>
    </form></section>` : ''}
</div>` : html`<section class="card"><p class="empty">No replies here yet.</p></section>`}`;
};
acts.replyFilter = (el) => { replyFilter = el.dataset.v; replyOpen = null; rerender(); };
acts.openReply = (el) => { replyOpen = Number(el.dataset.id); rerender(); };
changes.relabel = async (el) => { await post(`/api/replies/${el.dataset.id}/label`, { label: el.value }); toast('Label updated.'); rerender(); };
forms.sendReply = async (f, d) => { await post(`/api/replies/${d.id}/reply`, { body: d.body }); toast('Reply sent.'); rerender(); };

/* ------------------------------------------------------------------ */
/* Campaigns                                                           */
/* ------------------------------------------------------------------ */

pages.campaigns = async (params) => {
  if (params[0]) return campaignPage(Number(params[0]));
  const list = await api('/api/campaigns');
  return html`
<header class="page-head"><div><p class="eyebrow">Campaigns</p><h1>${list.length ? `${list.filter((c) => c.status === 'running').length} running` : 'Your first campaign'}</h1>
<p class="sub">A campaign is a sequence of emails and calls. Gridline.io sends the emails, puts calls on your list and stops as soon as someone replies.</p></div>
<button class="btn primary" data-act="newCampaign">+ New campaign</button></header>
${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Status</th><th class="num">Leads</th><th class="num">Contacted</th><th class="num">Replied</th><th class="num">Interested</th></tr></thead><tbody>
${list.map((c) => { const total = Object.values(c.counts).reduce((a, b) => a + b, 0); return html`<tr class="click" data-act="openCampaign" data-id="${c.id}"><td><a href="#/campaigns/${c.id}"><strong>${c.name}</strong></a><div class="sec">${c.steps.filter((s) => s.type === 'email').length} emails · ${c.steps.filter((s) => s.type === 'call').length} calls</div></td><td>${badge(CAMP_STATUS, c.status)}</td><td class="num">${total}</td><td class="num">${c.contacted}</td><td class="num">${c.replied}${c.contacted ? html` <span class="sec">(${pct(c.replied / c.contacted * 100)})</span>` : ''}</td><td class="num">${c.interested}</td></tr>`; })}
</tbody></table></div>` : html`<section class="card"><p class="empty">No campaigns yet. Start one and Gridline.io fills in a proven 4-step sequence (email, call, email, email) for you to edit.</p></section>`}`;
};
acts.newCampaign = async () => { const r = await post('/api/campaigns', { name: 'New campaign' }); go('#/campaigns/' + r.id); };
acts.openCampaign = (el) => go('#/campaigns/' + el.dataset.id);

let cd = null; let cTab = 'sequence'; let cInboxes = []; let cPreview = null;
async function campaignPage(id) {
  if (!cd || cd.id !== id || cd._reload) {
    const [c, inboxes] = await Promise.all([api('/api/campaigns/' + id), api('/api/inboxes')]);
    cd = { ...c, days: String(c.days).split(',').filter(Boolean).map(Number) };
    cInboxes = inboxes;
    cPreview = null;
  }
  const c = cd;
  const running = c.status === 'running';
  const total = Object.values(c.counts).reduce((a, b) => a + b, 0);
  const tabs = [['sequence', 'Sequence'], ['leads', `Leads (${total})`], ['schedule', 'Schedule & inboxes'], ['lia', 'Legitimate interest'], ['preview', 'Preview']];
  return html`
<header class="page-head"><div><p class="eyebrow"><a href="#/campaigns">Campaigns</a> › ${badge(CAMP_STATUS, c.status)}</p>
<label class="sr-only" for="cname" style="position:absolute;left:-9999px">Campaign name</label>
<input id="cname" type="text" data-bind="cName" value="${c.name}" style="font-size:26px;font-weight:800;color:var(--navy);border:0;padding:0;min-height:40px;background:transparent;width:min(720px, 80vw)"></div>
<div class="row"><button class="btn" data-act="saveCampaign">Save</button><button class="btn" data-act="testCampaign">Send test to me</button>
${running ? html`<button class="btn dark" data-act="pauseCampaign">Pause</button>` : html`<button class="btn primary" data-act="launchCampaign">${c.status === 'paused' ? 'Resume' : 'Launch'}</button>`}</div></header>
<div class="tiles"><div class="tile"><div class="k">Leads</div><div class="v">${total}</div><div class="n">${c.counts.queued || 0} waiting · ${c.counts.active || 0} in sequence</div></div>
<div class="tile"><div class="k">Contacted</div><div class="v">${c.contacted}</div></div>
<div class="tile"><div class="k">Replied</div><div class="v">${c.replied}</div><div class="n">${c.contacted ? pct(c.replied / c.contacted * 100) + ' reply rate' : ''}</div></div>
<div class="tile"><div class="k">Interested</div><div class="v">${c.interested}</div></div></div>
${c.problems.length && !running ? html`<div class="notice"><strong>Before you can launch:</strong><ul>${c.problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : ''}
${(c.counts.blocked || 0) + (c.will_hold || 0) > 0 ? html`<div class="notice">${(c.counts.blocked || 0) + (c.will_hold || 0)} lead${(c.counts.blocked || 0) + (c.will_hold || 0) === 1 ? ' is' : 's are'} held back by the safety guard. See the Leads tab for why and how to fix it.</div>` : ''}
<div class="tabs" role="tablist">${tabs.map(([k, l]) => html`<button role="tab" aria-selected="${cTab === k}" data-act="cTab" data-v="${k}">${l}</button>`)}</div>
${campaignTab(c)}`;
}

function campaignTab(c) {
  if (cTab === 'sequence') {
    const statFor = (s) => {
      if (s.type === 'call') { const x = c.call_stats.find((r) => r.step_position === s.position); return x ? `${x.n} calls listed · ${x.done || 0} made` : ''; }
      const x = c.step_stats.find((r) => r.step_position === s.position); return x ? `${x.n} sent` : '';
    };
    let emailIdx = 0;
    return html`<section class="stack">
<p class="sub">Merge fields: <code>{{FirstName}}</code> <code>{{Company}}</code> <code>{{JobTitle}}</code> <code>{{PersonalLine}}</code> <code>{{SenderFirstName}}</code>, any extra column from your import, fallbacks like <code>{{FirstName|there}}</code> and variations like <code>{{random: Hi | Hello}}</code>. Gridline.io adds your opt-out line, unsubscribe link and privacy notice automatically.</p>
<div class="steps">${c.steps.map((s, i) => { const isFirstEmail = s.type === 'email' && emailIdx++ === 0; return html`
<div class="step ${s.type}">
  <div class="step-head"><span class="step-type">Step ${i + 1} · ${s.type === 'call' ? 'Phone call' : 'Email'}</span>
  <div class="row">${i > 0 ? html`<span class="delay"><label for="delay-${i}">Wait</label><input id="delay-${i}" type="number" min="0" max="60" value="${s.delay_days}" data-bind="stepField" data-i="${i}" data-f="delay_days"> days</span>` : html`<span class="small muted">Sends first</span>`}
  <span class="small muted">${statFor(s)}</span>
  <button class="btn small" data-act="moveStep" data-i="${i}" data-d="-1" aria-label="Move step up" ${raw(i === 0 ? 'disabled' : '')}>↑</button>
  <button class="btn small" data-act="moveStep" data-i="${i}" data-d="1" aria-label="Move step down" ${raw(i === c.steps.length - 1 ? 'disabled' : '')}>↓</button>
  <button class="btn small danger" data-act="removeStep" data-i="${i}">Remove</button></div></div>
  ${s.type === 'email' ? html`<label class="field">Subject${isFirstEmail ? '' : html`<span class="hint">Leave blank to reply in the same thread (recommended)</span>`}<input type="text" value="${s.subject}" data-bind="stepField" data-i="${i}" data-f="subject"></label>
  <label class="field">Email<textarea rows="8" data-bind="stepField" data-i="${i}" data-f="body">${s.body}</textarea></label>`
  : html`<label class="field">Call script<span class="hint">Shown on your call list when this step is due</span><textarea rows="5" data-bind="stepField" data-i="${i}" data-f="body">${s.body}</textarea></label>`}
</div>`; })}</div>
<div class="row"><button class="btn" data-act="addStep" data-t="email">+ Email step</button><button class="btn" data-act="addStep" data-t="call">+ Call step</button></div></section>`;
  }
  if (cTab === 'leads') {
    return html`<section class="stack">
<div class="row between"><p class="sub" style="margin:0">Leads go through the sequence one by one, inside your sending hours and inbox limits.</p>
<div class="row"><button class="btn" data-act="addLeadsStatus" data-s="new">Add all new leads</button><a class="btn" href="#/leads">Choose from leads</a></div></div>
${c.enrollments.length ? html`<div class="table-wrap"><table><thead><tr><th>Lead</th><th>Status</th><th>Progress</th><th>Notes</th><th></th></tr></thead><tbody>
${c.enrollments.map((e) => html`<tr><td><strong>${fullName(e)}</strong><div class="sec">${e.email} · ${e.company}</div></td><td>${badge(ENR_STATUS, e.status)}</td>
<td class="small">${e.current_step ? `Step ${e.current_step} of ${c.steps.length} done` : 'Not started'}${e.status === 'active' && e.next_due_at ? html`<div class="sec">Next: ${when(e.next_due_at)}</div>` : ''}</td>
<td class="small" style="max-width:360px;color:${e.status === 'blocked' || e.warn ? 'var(--bad)' : 'var(--muted)'}">${e.note}${e.status === 'blocked' || e.warn ? html` <a href="#/leads" data-act="openLead" data-id="${e.lead_id}">Fix</a>` : ''}</td>
<td><button class="btn small" data-act="removeEnrollment" data-id="${e.id}">Remove</button></td></tr>`)}
</tbody></table></div>` : html`<div class="card"><p class="empty">No leads in this campaign yet. Import leads on the Leads page, then add them here.</p></div>`}</section>`;
  }
  if (cTab === 'schedule') {
    const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const hours = Array.from({ length: 24 }, (_, h) => h);
    return html`<section class="card stack">
<h2>When to send</h2>
<fieldset style="border:0;padding:0;margin:0"><legend class="small" style="font-weight:600;margin-bottom:6px">Days</legend><div class="row">${DAYS.map((d, i) => html`<label class="check"><input type="checkbox" data-change="cDay" value="${i + 1}" ${raw(c.days.includes(i + 1) ? 'checked' : '')}>${d}</label>`)}</div></fieldset>
<div class="form-grid"><label class="field">From<select data-change="cHour" data-f="start_hour">${hours.map((h) => html`<option value="${h}" ${raw(c.start_hour === h ? 'selected' : '')}>${String(h).padStart(2, '0')}:00</option>`)}</select></label>
<label class="field">Until<select data-change="cHour" data-f="end_hour">${hours.map((h) => html`<option value="${h + 1}" ${raw(c.end_hour === h + 1 ? 'selected' : '')}>${String(h + 1).padStart(2, '0')}:00</option>`)}</select></label></div>
<p class="small muted" style="margin:0">Times are in ${state.me.workspace.timezone}. Emails are spaced a few minutes apart so they look hand-sent.</p>
<label class="check"><input type="checkbox" data-change="cOnePer" ${raw(c.one_per_company ? 'checked' : '')}><span>Only start one new conversation per company per day<br><span class="small muted">Stops two people at the same company getting the same email on the same morning.</span></span></label>
<h2 style="margin-top:8px">Send from</h2>
${cInboxes.length ? html`<div class="stack">${cInboxes.map((i) => html`<label class="check"><input type="checkbox" data-change="cInbox" value="${i.id}" ${raw(c.inbox_ids.includes(i.id) ? 'checked' : '')}><span>${i.email} <span class="small muted">· up to ${i.daily_limit} a day${i.status !== 'active' ? ' · ' + i.status : ''}</span></span></label>`)}</div>
<p class="small muted" style="margin:0">With several inboxes, Gridline.io shares the sending between them. Each conversation always continues from the same inbox.</p>`
  : html`<p class="empty">No inboxes connected. <a href="#/settings/inboxes">Connect one</a>.</p>`}
</section>`;
  }
  if (cTab === 'lia') {
    return html`<section class="card stack">
<div><h2>Legitimate interest check</h2><p class="sub">UK GDPR lets you email business contacts without consent when you have a "legitimate interest" and have weighed it against their rights. Write it down here once per campaign. It's saved in your audit log, so you can show it if anyone ever asks.</p></div>
<label class="field">1. What's the purpose of this campaign?<span class="hint">e.g. "To offer our commercial cleaning service to offices in Manchester."</span><textarea rows="3" data-bind="cField" data-f="lia_purpose">${c.lia_purpose}</textarea></label>
<label class="field">2. Why is it relevant to the people you're contacting?<span class="hint">e.g. "They run office buildings and are responsible for choosing suppliers like us."</span><textarea rows="3" data-bind="cField" data-f="lia_relevance">${c.lia_relevance}</textarea></label>
<label class="field">3. How are you protecting their interests?<span class="hint">e.g. "Work emails only, low volume, easy one-click opt-out, data deleted after 12 months of no contact."</span><textarea rows="3" data-bind="cField" data-f="lia_balance">${c.lia_balance}</textarea></label>
<p class="small muted" style="margin:0">This is a guided record, not legal advice. If you're unsure, the ICO has free guidance on legitimate interests.</p>
</section>`;
  }
  // preview
  return html`<section class="stack">
<div class="row"><label class="field" style="min-width:260px">Preview for<select data-change="previewLead"><option value="">${c.enrollments.length ? 'First lead in campaign' : 'Example lead'}</option>${c.enrollments.slice(0, 100).map((e) => html`<option value="${e.lead_id}">${fullName(e)} · ${e.company}</option>`)}</select></label>
<button class="btn" data-act="runPreview">Show preview</button></div>
${cPreview ? html`<p class="small muted" style="margin:0">Showing how the sequence reads for ${cPreview.lead.name || cPreview.lead.email}.</p>
${cPreview.steps.map((s, i) => html`<div class="card stack"><div class="step-type">Step ${i + 1} · ${s.type === 'call' ? 'Phone call' : 'Email'}</div>
${s.type === 'call' ? html`<div class="pre">${s.script}</div>` : html`${s.errors.length ? html`<div class="error-box">Won't send: ${s.errors.join('; ')}</div>` : ''}<div><strong>Subject:</strong> ${s.subject}</div><div class="pre">${s.text}</div>`}</div>`)}`
  : html`<p class="muted">Click "Show preview" to see each email exactly as it will be sent, including the compliance footer.</p>`}
</section>`;
}

acts.cTab = (el) => { cTab = el.dataset.v; rerender(); };
changes.cName = (el) => { cd.name = el.value; };
changes.cField = (el) => { cd[el.dataset.f] = el.value; };
changes.stepField = (el) => { const s = cd.steps[Number(el.dataset.i)]; s[el.dataset.f] = el.dataset.f === 'delay_days' ? Number(el.value) : el.value; };
acts.addStep = (el) => {
  cd.steps.push(el.dataset.t === 'call'
    ? { type: 'call', delay_days: 2, subject: '', body: "Hi {{FirstName}}, it's {{SenderFirstName}}. I emailed you recently about [topic]. Did it reach you?" }
    : { type: 'email', delay_days: 3, subject: '', body: 'Hi {{FirstName}},\n\n\n\nThanks,\n{{SenderFirstName}}' });
  re};
acts.removeStep = (el) => { cd.steps.splice(Number(el.dataset.i), 1); rerender(); };
acts.moveStep = (el) => { const i = Number(el.dataset.i), j = i + Number(el.dataset.d); [cd.steps[i], cd.steps[j]] = [cd.steps[j], cd.steps[i]]; rerender(); };
changes.cDay = (el) => { const d = Number(el.value); cd.days = el.checked ? [...new Set([...cd.days, d])].sort() : cd.days.filter((x) => x !== d); };
changes.cHour = (el) => { cd[el.dataset.f] = Number(el.value); };
changes.cOnePer = (el) => { cd.one_per_company = el.checked ? 1 : 0; };
changes.cInbox = (el) => { const id = Number(el.value); cd.inbox_ids = el.checked ? [...new Set([...cd.inbox_ids, id])] : cd.inbox_ids.filter((x) => x !== id); };
let previewLeadId = '';
changes.previewLead = (el) => { previewLeadId = el.value; };
acts.runPreview = async () => { cPreview = await post(`/api/campaigns/${cd.id}/preview`, { lead_id: previewLeadId || undefined, steps: cd.steps }); rerender(); };

async function saveCampaign(quiet) {
  await put('/api/campaigns/' + cd.id, {
    name: cd.name, days: cd.days, start_hour: cd.start_hour, end_hour: cd.end_hour, one_per_company: !!cd.one_per_company,
    lia_purpose: cd.lia_purpose, lia_relevance: cd.lia_relevance, lia_balance: cd.lia_balance,
    steps: cd.steps.map((s) => ({ type: s.type, delay_days: s.delay_days, subject: s.subject, body: s.body })), inbox_ids: cd.inbox_ids
  });
  cd._reload = true;
  if (!quiet) toast('Saved.');
}
acts.saveCampaign = async () => { await saveCampaign(); rerender(); };
acts.testCampaign = async (el) => { el.disabled = true; await saveCampaign(true); const r = await post(`/api/campaigns/${cd.id}/test`); toast(`Sent ${r.sent} test email${r.sent === 1 ? '' : 's'} to ${r.to}.`); rerender(); };
acts.launchCampaign = () => confirmBox('Launch this campaign?', 'Gridline.io will start sending in your sending hours, within each inbox\'s daily limit. You can pause it at any time.', 'Launch', async () => {
  await saveCampaign(true); await post(`/api/campaigns/${cd.id}/launch`); toast('Campaign launched.'); re});
acts.pauseCampaign = async () => { await post(`/api/campaigns/${cd.id}/pause`); cd._reload = true; toast('Campaign paused.'); rerender(); };
acts.addLeadsStatus = async (el) => { await saveCampaign(true); const r = await post(`/api/campaigns/${cd.id}/leads`, { status: el.dataset.s }); toast(`${r.added} lead${r.added === 1 ? '' : 's'} added.`); rerender(); };
acts.removeEnrollment = async (el) => { await del(`/api/campaigns/${cd.id}/leads/${el.dataset.id}`); cd._reload = true; rerender(); };

/* ------------------------------------------------------------------ */
/* Leads                                                               */
/* ------------------------------------------------------------------ */

let leadFilter = 'all', leadQuery = '', leadPage = 1; const leadSel = new Set();
pages.leads = async () => {
  const [d, camps] = await Promise.all([api(`/api/leads?status=${leadFilter}&q=${encodeURIComponent(leadQuery)}&page=${leadPage}`), api('/api/campaigns')]);
  const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
  const filters = [['all', 'All', total], ...Object.entries(LEAD_STATUS).filter(([k]) => d.counts[k]).map(([k, [l]]) => [k, l, d.counts[k]])];
  return html`
<header class="page-head"><div><p class="eyebrow">Leads</p><h1>${total} lead${total === 1 ? '' : 's'}</h1>
<p class="sub">Import a spreadsheet, or add people from Growth signals. Every lead records where you got their details, for the privacy notice in your first email.</p></div>
<div class="row"><button class="btn" data-act="addLeadModal">Add a lead</button><button class="btn primary" data-act="importModal">Import CSV</button></div></header>
<div class="row between"><div class="row" role="group" aria-label="Filter by status">${filters.map(([k, l, n]) => html`<button class="chip-btn" data-act="leadFilter" data-v="${k}" aria-pressed="${leadFilter === k}">${l} ${n}</button>`)}</div>
<form data-form="leadSearch" class="row"><label for="lq" style="position:absolute;left:-9999px">Search leads</label><input id="lq" type="search" name="q" value="${leadQuery}" placeholder="Search name, company or email" style="width:260px"><button class="btn" type="submit">Search</button></form></div>
${leadSel.size ? html`<div class="notice info row between"><span>${leadSel.size} selected</span><div class="row"><label for="addToCamp" style="position:absolute;left:-9999px">Campaign</label><select id="addToCamp" style="width:240px">${camps.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select><button class="btn dark" data-act="addSelectedToCampaign" ${raw(camps.length ? '' : 'disabled')}>Add to campaign</button><button class="btn" data-act="clearSel">Clear</button></div></div>` : ''}
${d.rows.length ? html`<div class="table-wrap"><table><thead><tr><th><span style="position:absolute;left:-9999px">Select</span></th><th>Name</th><th>Company</th><th>Status</th><th>Campaign</th><th>Notes</th></tr></thead><tbody>
${d.rows.map((l) => html`<tr><td><input type="checkbox" aria-label="Select ${fullName(l)}" data-change="selLead" value="${l.id}" ${raw(leadSel.has(l.id) ? 'checked' : '')} style="width:20px;height:20px"></td>
<td><a href="#/leads" data-act="openLead" data-id="${l.id}"><strong>${fullName(l)}</strong></a><div class="sec">${l.email}${l.personal ? html` <span class="badge b-warn">Personal email</span>` : ''}</div></td>
<td>${l.company}<div class="sec">${l.title}</div></td><td>${badge(LEAD_STATUS, l.status)}</td>
<td class="small">${l.enrollment ? html`${l.enrollment.name}<div class="sec">${ENR_STATUS[l.enrollment.status] ? ENR_STATUS[l.enrollment.status][0] : l.enrollment.status}</div>` : html`<span class="muted">–</span>`}</td>
<td class="small" style="max-width:320px;color:${l.enrollment && l.enrollment.status === 'blocked' ? 'var(--bad)' : 'var(--muted)'}">${l.enrollment && l.enrollment.note ? l.enrollment.note : !l.source ? 'No source recorded' : ''}</td></tr>`)}
</tbody></table></div>
${d.total > 100 ? html`<div class="row"><button class="btn small" data-act="leadPage" data-d="-1" ${raw(leadPage === 1 ? 'disabled' : '')}>Previous</button><span class="small muted">Page ${leadPage} of ${Math.ceil(d.total / 100)}</span><button class="btn small" data-act="leadPage" data-d="1" ${raw(leadPage * 100 >= d.total ? 'disabled' : '')}>Next</button></div>` : ''}`
  : html`<section class="card"><p class="empty">${total ? 'No leads match.' : 'No leads yet. Import a CSV from Apollo, LinkedIn Sales Navigator, a spreadsheet, or add them from Growth signals.'}</p></section>`}`;
};
acts.leadFilter = (el) => { leadFilter = el.dataset.v; leadPage = 1; rerender(); };
acts.leadPage = (el) => { leadPage += Number(el.dataset.d); rerender(); };
forms.leadSearch = (f, d) => { leadQuery = d.q || ''; leadPage = 1; rerender(); };
changes.selLead = (el) => { const id = Number(el.value); if (el.checked) leadSel.add(id); else leadSel.delete(id); rerender(); };
acts.clearSel = () => { leadSel.clear(); rerender(); };
acts.addSelectedToCampaign = async () => {
  const id = document.getElementById('addToCamp').value;
  const r = await post(`/api/campaigns/${id}/leads`, { lead_ids: [...leadSel] });
  leadSel.clear(); toast(`${r.added} lead${r.added === 1 ? '' : 's'} added to the campaign.`); cd = null; re};

const LEAD_FORM = (l = {}) => html`<div class="form-grid">
<label class="field">First name<input type="text" name="first_name" value="${l.first_name}"></label>
<label class="field">Last name<input type="text" name="last_name" value="${l.last_name}"></label>
${l.id ? '' : html`<label class="field">Work email<input type="email" name="email" required></label>`}
<label class="field">Company<input type="text" name="company" value="${l.company}"></label>
<label class="field">Job title<input type="text" name="title" value="${l.title}"></label>
<label class="field">Phone<input type="tel" name="phone" value="${l.phone}"></label></div>
<label class="field">Personal line<span class="hint">Optional opening line, used as {{PersonalLine}}</span><input type="text" name="personal_line" value="${l.personal_line}"></label>
<label class="field">Source<span class="hint">Where you got their details, e.g. "Acme Ltd website" or "LinkedIn". Shown in the privacy line of your first email.</span><input type="text" name="source" value="${l.source}" required></label>
<label class="check"><input type="checkbox" name="consent" value="1" ${raw(l.consent ? 'checked' : '')}><span>They have consented to marketing emails<br><span class="small muted">Only tick this if they actually agreed. Needed for personal addresses like Gmail or Hotmail.</span></span></label>`;

acts.addLeadModal = () => openModal(html`<form data-form="addLead" class="stack"><h2>Add a lead</h2><div class="error-box form-error" hidden></div>${LEAD_FORM()}
<div class="row"><button class="btn primary" type="submit">Add lead</button><button class="btn" type="button" data-act="closeModal">Cancel</button></div></form>`);
forms.addLead = async (f, d) => { await post('/api/leads', { ...d, consent: !!d.consent }); closeModal(); toast('Lead added.'); rerender(); };

acts.openLead = async (el) => {
  const d = await api('/api/leads/' + el.dataset.id);
  const l = d.lead;
  openModal(html`<form data-form="saveLead" class="stack"><input type="hidden" name="id" value="${l.id}">
<div class="row between"><div><h2>${fullName(l)}</h2><div class="small muted">${l.email}</div></div>${badge(LEAD_STATUS, l.status)}</div>
${l.suppressed ? html`<div class="notice">On your Do Not Contact list. Gridline.io will never email them.</div>` : ''}
<div class="error-box form-error" hidden></div>${LEAD_FORM(l)}
<div class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="closeModal">Close</button><button class="btn danger" type="button" data-act="forgetLead" data-id="${l.id}" style="margin-left:auto">Erase (GDPR request)</button></div>
${d.enrollments.length ? html`<div><h3>Campaigns</h3>${d.enrollments.map((e) => html`<div class="small">${e.name}: ${ENR_STATUS[e.status] ? ENR_STATUS[e.status][0] : e.status}${e.note ? ' – ' + e.note : ''}</div>`)}</div>` : ''}
${d.messages.length ? html`<div class="stack"><h3>History</h3>${d.messages.map((m) => html`<div class="msg ${m.direction}"><div class="meta">${m.direction === 'out' ? 'You' : 'Them'} · ${when(m.created_at)}${m.label ? ' · ' + (LABELS[m.label] ? LABELS[m.label][0] : m.label) : ''}</div><div class="body small">${String(m.body_text).slice(0, 600)}</div></div>`)}</div>` : ''}
</form>`);
};
forms.saveLead = async (f, d) => { await put('/api/leads/' + d.id, { ...d, consent: !!d.consent }); closeModal(); toast('Saved. Any held emails will be retried.'); rerender(); };
acts.forgetLead = (el) => confirmBox('Erase this person?', 'All their details and history will be deleted. Their email address stays on your Do Not Contact list only, so they are never contacted again. This can\'t be undone.', 'Erase', async () => {
  await post(`/api/leads/${el.dataset.id}/forget`); toast('Erased.'); re});

/* ---------- import ---------- */

function parseCsvClient(text) {
  const rows = []; let row = [], f = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((c) => c.trim())) rows.push(row); row = []; if (rows.length > 3) break; }
    else f += ch;
  }
  if (f || row.length) { row.push(f); if (row.some((c) => c.trim())) rows.push(row); }
  return rows;
}
let importCsv = '';
const IMPORT_FIELDS = [['email', 'Email', /e-?mail/i], ['first_name', 'First name', /first|forename|given/i], ['last_name', 'Last name', /last|surname|family/i],
  ['company', 'Company', /company|organi[sz]ation|business|employer/i], ['title', 'Job title', /title|position|role/i], ['phone', 'Phone', /phone|mobile|tel/i],
  ['website', 'Website', /website|domain|url/i], ['source', 'Source', /source/i], ['personal_line', 'Personal line', /personal|opener|first line|icebreaker/i]];
acts.importModal = () => {
  importCsv = '';
  openModal(html`<div class="stack"><h2>Import leads from a CSV file</h2><p class="small muted" style="margin:0">Export from Apollo, Sales Navigator or Excel as CSV. Duplicates are skipped automatically.</p>
<label class="field">CSV file<input type="file" accept=".csv,text/csv" data-change="csvFile"></label><div id="mapping"></div></div>`);
};
changes.csvFile = async (el) => {
  const file = el.files[0];
  if (!file) return;
  if (file.size > 4.5 * 1024 * 1024) throw new Error('That file is over 4.5 MB. Split it into smaller files.');
  importCsv = await file.text();
  const rows = parseCsvClient(importCsv);
  if (!rows.length) throw new Error('That file looks empty.');
  const header = rows[0].map((h) => h.trim());
  const guess = (re) => header.find((h) => re.test(h)) || '';
  document.getElementById('mapping').innerHTML = html`<form data-form="doImport" class="stack"><div class="error-box form-error" hidden></div>
<p class="small" style="margin:0">Match your columns. Any column you don't match becomes a merge field you can use in emails, like <code>{{Industry}}</code>.</p>
<div class="form-grid">${IMPORT_FIELDS.map(([k, label, re]) => html`<label class="field">${label}<select name="map_${k}"><option value="">Not in file</option>${header.map((h) => html`<option ${raw(guess(re) === h ? 'selected' : '')}>${h}</option>`)}</select></label>`)}</div>
<label class="field">Source for everyone in this file<span class="hint">Where these details came from, e.g. "Apollo.io business database" or "Company websites". Used if the file has no Source column.</span><input type="text" name="source" required></label>
<label class="check"><input type="checkbox" name="consent" value="1"><span>Everyone in this file has consented to marketing emails</span></label>
<div class="row"><button class="btn primary" type="submit">Import</button><button class="btn" type="button" data-act="closeModal">Cancel</button></div></form>`.__html;
};
forms.doImport = async (f, d) => {
  const mapping = {};
  for (const [k] of IMPORT_FIELDS) if (d['map_' + k]) mapping[k] = d['map_' + k];
  const r = await post('/api/leads/import', { csv: importCsv, mapping, source: d.source, consent: !!d.consent });
  closeModal();
  toast(`${r.added} added${r.duplicates ? `, ${r.duplicates} duplicates skipped` : ''}${r.invalid ? `, ${r.invalid} without a valid email` : ''}.${r.limit_note ? ' ' + r.limit_note : ''}`, !!r.limit_note);
  re};

/* ------------------------------------------------------------------ */
/* Growth signals                                                      */
/* ------------------------------------------------------------------ */

let signalOpen = null;
pages.signals = async () => {
  const d = await api('/api/signals');
  return html`
<header class="page-head"><div><p class="eyebrow">Growth signals</p><h1>Companies hiring right now</h1>
<p class="sub">A company advertising jobs is growing, and has budget and problems you might solve. Search live UK job adverts, then add the right person as a lead with a ready-made opening line.</p></div></header>
${d.configured ? html`<form data-form="signalSearch" class="card row" style="align-items:flex-end"><div class="error-box form-error" hidden style="flex-basis:100%"></div>
<label class="field" style="flex:2 1 220px">Job titles or keywords<input type="text" name="what" placeholder="e.g. office manager" required></label>
<label class="field" style="flex:1 1 160px">Location<input type="text" name="where" placeholder="e.g. Manchester"></label>
<label class="field" style="flex:0 1 140px">Posted in the last<select name="days"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option></select></label>
<button class="btn primary" type="submit">Find companies</button></form>`
  : html`<div class="notice info">To use Growth signals, get a free API key from Adzuna (developer.adzuna.com) and add it in <a href="#/settings/signals">Settings → Growth signals</a>. It takes about two minutes.</div>`}
${d.companies.length ? html`<div class="stack">${d.companies.map((co) => html`<section class="card">
<div class="card-head"><div><h2>${co.company}</h2><div class="small muted">${co.jobs.length} open role${co.jobs.length === 1 ? '' : 's'}${co.has_lead ? ' · already in your leads' : ''}</div></div>
<div class="row"><button class="btn small" data-act="signalAdd" data-id="${co.jobs[0].id}">Add a contact</button><button class="btn small" data-act="signalDismiss" data-id="${co.jobs[0].id}">Dismiss</button></div></div>
<div class="list">${co.jobs.slice(0, 5).map((j) => html`<div class="list-item row between small"><span><strong>${j.job_title}</strong> · ${j.location}</span><span class="muted">${j.posted_at} · <a href="${j.url}" target="_blank" rel="noopener noreferrer">Advert</a></span></div>`)}</div>
${signalOpen === co.jobs[0].id ? html`<form data-form="signalLead" class="stack" style="margin-top:12px;border-top:1px solid var(--line-2);padding-top:12px"><input type="hidden" name="id" value="${co.jobs[0].id}"><div class="error-box form-error" hidden></div>
<p class="small muted" style="margin:0">Find the hiring manager (e.g. via LinkedIn or the company website) and add their work details. Gridline.io writes the opening line and records the job advert as the source.</p>
<div class="form-grid"><label class="field">First name<input type="text" name="first_name" required></label><label class="field">Last name<input type="text" name="last_name"></label>
<label class="field">Work email<input type="email" name="email" required></label><label class="field">Job title<input type="text" name="title"></label><label class="field">Phone<input type="tel" name="phone"></label></div>
<label class="field">Opening line<input type="text" name="personal_line" value="I saw you're hiring for a ${co.jobs[0].job_title}${co.jobs[0].location ? ' in ' + co.jobs[0].location : ''}."></label>
<div class="row"><button class="btn primary" type="submit">Add lead</button></div></form>` : ''}
</section>`)}</div>` : d.configured ? html`<section class="card"><p class="empty">Search above to find companies that are hiring.</p></section>` : ''}`;
};
forms.signalSearch = async (f, d) => { const r = await post('/api/signals/search', d); toast(`Found ${r.found} adverts, ${r.added} new.`); rerender(); };
acts.signalAdd = (el) => { signalOpen = Number(el.dataset.id); rerender(); };
acts.signalDismiss = async (el) => { await post(`/api/signals/${el.dataset.id}/dismiss`); rerender(); };
forms.signalLead = async (f, d) => { await post(`/api/signals/${d.id}/lead`, d); signalOpen = null; toast('Lead added. Add it to a campaign from the Leads page.'); rerender(); };

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

pages.settings = async (params) => {
  const [tabRaw, query] = String(params[0] || 'compliance').split('?');
  const tab = tabRaw;
  if (tab === 'billing' && /paid=1/.test(query || '') && !billingThanked) { billingThanked = true; await refreshMe(); setTimeout(() => toast('Thank you! Your plan is active.'), 50); }
  const tabs = [['compliance', 'Compliance'], ['billing', 'Plan & billing'], ['team', 'Team'], ['display', 'Display'], ['inboxes', 'Inboxes'], ['dnc', 'Do Not Contact'], ['audit', 'Audit log'], ['signals', 'Growth signals']];
  let body = '';
  if (tab === 'billing') {
    body = await billingTab();
  } else if (tab === 'team') {
    body = await teamTab();
  } else if (tab === 'display') {
    const cur = state.me.user.theme || 'system';
    const opts = [['light', 'Light', 'Bright and clear, best in daylight'], ['dark', 'Dark', 'Easier on the eyes at night'], ['system', 'Match my device', 'Follows your phone or computer setting']];
    const n = tzNow();
    body = html`<section class="stack"><div class="card stack"><div><h2>Appearance</h2><p class="sub">Choose how Gridline.io looks for you. This is saved to your login, so it follows you to other devices.</p></div>
<div class="theme-pick" role="group" aria-label="Appearance">${opts.map(([k, l, h]) => html`<button type="button" class="theme-opt" data-act="setTheme" data-v="${k}" aria-pressed="${cur === k}"><span class="sw ${k}" aria-hidden="true"><i></i><i></i></span><span>${l}<span class="small muted" style="display:block;font-weight:400">${h}</span></span></button>`)}</div></div>
<div class="card stack"><div><h2>Date and time</h2><p class="sub">Your greeting, clock, sending hours and call list all use your workspace time zone. Change it in <a href="#/settings/compliance">Compliance</a>.</p></div>
<div class="row between"><span><strong>${state.me.workspace.timezone}</strong></span><span class="num"><span data-live="date">${n.date}</span>, <strong data-live="time">${n.time}</strong></span></div></div></section>`;
  } else if (tab === 'compliance' || tab === 'signals') {
    const s = await api('/api/settings');
    body = tab === 'compliance' ? html`<form data-form="saveSettings" class="card stack"><div class="error-box form-error" hidden></div>
<div><h2>Your business details</h2><p class="sub">Shown at the bottom of every email. UK law requires limited companies to include their name, registered number and address, and every marketing email needs a way to opt out.</p></div>
${s.problems.length ? html`<div class="notice">Still needed:<ul>${s.problems.map((p) => html`<li>${p}</li>`)}</ul></div>` : html`<div class="notice good">All set. Your emails will carry the right details.</div>`}
<div class="form-grid"><label class="field">Workspace name<input type="text" name="name" value="${s.name}"></label>
<label class="field">Legal business name<input type="text" name="business_name" value="${s.business_name}" placeholder="e.g. Acme Ltd"></label>
<label class="field">Company number<span class="hint">If you're a limited company</span><input type="text" name="company_number" value="${s.company_number}"></label></div>
<label class="field">Business address<input type="text" name="business_address" value="${s.business_address}"></label>
<label class="field">Privacy notice link<span class="hint">A page on your website explaining how you use people's data</span><input type="url" name="privacy_url" value="${s.privacy_url}" placeholder="https://"></label>
<label class="field">Opt-out line<span class="hint">Added to every email, with a one-click unsubscribe link</span><input type="text" name="opt_out_text" value="${s.opt_out_text}"></label>
<div class="form-grid"><label class="field">Time zone<input type="text" name="timezone" value="${s.timezone}"></label>
<label class="field">Delete inactive leads after<span class="hint">Months with no contact (0 = never)</span><input type="number" name="retention_months" min="0" max="60" value="${s.retention_months}"></label></div>
<div class="row"><button class="btn primary" type="submit">Save</button></div></form>`
      : html`<form data-form="saveSettings" class="card stack"><div class="error-box form-error" hidden></div>
<div><h2>Growth signals</h2><p class="sub">Gridline.io finds companies hiring right now using Adzuna's UK jobs data. Create a free developer account at developer.adzuna.com, then paste your App ID and App Key here.</p></div>
<div class="form-grid"><label class="field">Adzuna App ID<input type="text" name="adzuna_app_id" value="${s.adzuna_app_id}"></label><label class="field">Adzuna App Key<input type="text" name="adzuna_app_key" value="${s.adzuna_app_key}"></label></div>
<div class="row"><button class="btn primary" type="submit">Save</button></div></form>`;
  } else if (tab === 'inboxes') {
    const list = await api('/api/inboxes');
    body = html`<section class="stack">${list.map((i) => html`<form data-form="saveInbox" class="card stack"><input type="hidden" name="id" value="${i.id}">
<div class="row between"><div><h2>${i.email}</h2><div class="small muted">${i.smtp_host} · ${i.sent_today} sent today · limit today ${i.limit_today}</div></div>
<span class="badge ${i.status === 'active' ? 'b-good' : i.status === 'paused' ? 'b-warn' : 'b-bad'}">${i.status === 'active' ? 'Connected' : i.status === 'paused' ? 'Paused' : 'Needs attention'}</span></div>
${i.last_error ? html`<div class="error-box small">${i.last_error}</div>` : ''}
<div class="form-grid"><label class="field">Name people see<input type="text" name="from_name" value="${i.from_name}"></label>
<label class="field">Daily limit<input type="number" name="daily_limit" min="1" max="200" value="${i.daily_limit}"></label>
<label class="field">First-day limit<input type="number" name="ramp_start" min="1" max="200" value="${i.ramp_start}"></label>
<label class="field">Increase per day<input type="number" name="ramp_step" min="0" max="50" value="${i.ramp_step}"></label></div>
<label class="field">Signature<textarea name="signature" rows="3">${i.signature}</textarea></label>
<div class="row"><button class="btn" type="submit">Save</button>
<button class="btn" type="button" data-act="toggleInbox" data-id="${i.id}" data-s="${i.status === 'active' ? 'paused' : 'active'}">${i.status === 'active' ? 'Pause' : 'Resume'}</button>
${i.status === 'error' ? html`<button class="btn dark" type="button" data-act="reconnectInbox" data-id="${i.id}">Reconnect</button>` : ''}
<button class="btn danger" type="button" data-act="removeInbox" data-id="${i.id}" style="margin-left:auto">Remove</button></div></form>`)}
<form data-form="addInbox" class="card stack"><div><h2>Connect an inbox</h2><p class="sub">Gridline.io sends from your own email account using an app password, so emails come from you and replies land in your normal inbox. Your password is stored encrypted.</p></div>
<div class="notice info small"><strong>Gmail or Google Workspace:</strong> turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords and paste it below. On Workspace, your admin may need to allow app passwords.</div>
<div class="error-box form-error" hidden></div>
<div class="form-grid"><label class="field">Provider<select name="provider" data-change="providerPick"><option value="gmail">Gmail / Google Workspace</option><option value="zoho">Zoho Mail (EU)</option><option value="fastmail">Fastmail</option><option value="other">Other (enter servers)</option></select></label>
<label class="field">Email address<input type="email" name="email" required></label><label class="field">Name people see<input type="text" name="from_name" required placeholder="e.g. Jane Smith"></label>
<label class="field">App password<input type="password" name="password" required autocomplete="new-password"></label></div>
<div class="form-grid" id="customServers" hidden><label class="field">SMTP server<input type="text" name="smtp_host"></label><label class="field">SMTP port<input type="number" name="smtp_port" value="465"></label>
<label class="field">IMAP server<input type="text" name="imap_host"></label><label class="field">IMAP port<input type="number" name="imap_port" value="993"></label><label class="field">Username<span class="hint">If different from the email</span><input type="text" name="username"></label></div>
<label class="field">Signature<textarea name="signature" rows="3" placeholder="Jane Smith&#10;Director, Acme Ltd&#10;0161 000 0000"></textarea></label>
<div class="row"><button class="btn primary" type="submit">Test and connect</button><span class="small muted">We'll log in to check it works before saving.</span></div></form></section>`;
  } else if (tab === 'dnc') {
    const list = await api('/api/suppression');
    body = html`<section class="stack"><form data-form="addDnc" class="card stack"><div><h2>Do Not Contact</h2><p class="sub">Shared by every campaign. Opt-outs, unsubscribes, bounces and erasure requests are added automatically. Add a whole company by entering its domain, like <code>competitor.co.uk</code>.</p></div>
<div class="error-box form-error" hidden></div><label class="field">Emails or domains<span class="hint">One per line, or separated by commas</span><textarea name="values" rows="3"></textarea></label>
<label class="field">Reason<input type="text" name="reason" placeholder="e.g. Existing client"></label><div class="row"><button class="btn primary" type="submit">Add</button></div></form>
<div class="table-wrap"><table><thead><tr><th>Email or domain</th><th>Reason</th><th>Added</th><th></th></tr></thead><tbody>
${list.length ? list.map((s) => html`<tr><td>${s.value}</td><td class="small">${s.reason}</td><td class="small muted">${when(s.created_at)}</td><td><button class="btn small" data-act="removeDnc" data-id="${s.id}">Remove</button></td></tr>`) : html`<tr><td colspan="4" class="muted">Nobody on the list yet.</td></tr>`}
</tbody></table></div></section>`;
  } else if (tab === 'audit') {
    const list = await api('/api/audit');
    body = html`<section class="stack"><div class="card row between"><div><h2>Audit log</h2><p class="sub">A permanent record of every email sent, opt-out, consent change, erasure and campaign launch, including each campaign's legitimate interest check. Useful if a customer or the ICO ever asks.</p></div>
<a class="btn primary" href="/api/audit.csv" download>Download full log (CSV)</a></div>
<div class="table-wrap"><table><thead><tr><th>When</th><th>By</th><th>What</th><th>Email</th><th>Detail</th></tr></thead><tbody>
${list.map((a) => html`<tr><td class="small muted" style="white-space:nowrap">${when(a.at)}</td><td class="small">${a.actor}</td><td class="small">${a.action.replace(/_/g, ' ')}</td><td class="small">${a.email}</td><td class="small" style="max-width:420px">${a.detail}</td></tr>`)}
</tbody></table></div></section>`;
  }
  return html`<header class="page-head"><div><p class="eyebrow">Settings</p><h1>${tabs.find((t) => t[0] === tab)[1]}</h1></div></header>
<div class="tabs" role="tablist">${tabs.map(([k, l]) => html`<button role="tab" aria-selected="${tab === k}" data-act="settingsTab" data-v="${k}">${l}</button>`)}</div>${body}`;
};
acts.settingsTab = (el) => go('#/settings/' + el.dataset.v);
acts.setTheme = async (el) => {
  applyTheme(el.dataset.v);
  document.querySelectorAll('.theme-opt').forEach((b) => b.setAttribute('aria-pressed', String(b === el)));
  const r = await put('/api/me/display', { theme: el.dataset.v });
  state.me.user.theme = r.theme;
  toast('Display updated.');
};
forms.saveSettings = async (f, d) => { const r = await put('/api/settings', d); await refreshMe(); toast(r.problems.length ? 'Saved. A few details are still needed.' : 'Saved.'); rerender(); };
changes.providerPick = (el) => { document.getElementById('customServers').hidden = el.value !== 'other'; };
forms.addInbox = async (f, d) => { toast('Testing the connection…'); await post('/api/inboxes', d); toast('Inbox connected.'); rerender(); };
forms.saveInbox = async (f, d) => { await put('/api/inboxes/' + d.id, d); toast('Saved.'); rerender(); };
acts.toggleInbox = async (el) => { await put('/api/inboxes/' + el.dataset.id, { status: el.dataset.s }); rerender(); };
acts.reconnectInbox = (el) => openModal(html`<form data-form="reconnect" class="stack"><h2>Reconnect inbox</h2><p class="small muted" style="margin:0">If you changed your password or app password, enter the new app password. Otherwise leave it blank to retry.</p>
<input type="hidden" name="id" value="${el.dataset.id}"><div class="error-box form-error" hidden></div><label class="field">App password<input type="password" name="password" autocomplete="new-password"></label>
<div class="row"><button class="btn primary" type="submit">Reconnect</button><button class="btn" type="button" data-act="closeModal">Cancel</button></div></form>`);
forms.reconnect = async (f, d) => { await post(`/api/inboxes/${d.id}/reconnect`, { password: d.password }); closeModal(); toast('Reconnected.'); rerender(); };
acts.removeInbox = (el) => confirmBox('Remove this inbox?', 'Campaigns will stop sending from it. Conversations already started from this inbox will pause.', 'Remove', async () => { await del('/api/inboxes/' + el.dataset.id); rerender(); });
forms.addDnc = async (f, d) => { const r = await post('/api/suppression', d); toast(`${r.added} added.`); rerender(); };
acts.removeDnc = async (el) => { await del('/api/suppression/' + el.dataset.id); rerender(); };
/* ------------------------------------------------------------------ */
/* Griddy: the built-in helper                                         */
/* ------------------------------------------------------------------ */

const GRIDDY_FACE = '<svg class="griddy-face" viewBox="0 0 40 40" aria-hidden="true"><rect x="2" y="2" width="36" height="36" rx="11" fill="#02204b"/><path d="M2 14h36M2 26h36M14 2v36M26 2v36" stroke="#ffffff" stroke-opacity=".12"/><circle cx="14" cy="17" r="3.4" fill="#ff8a3d"/><circle cx="26" cy="17" r="3.4" fill="#ff8a3d"/><path d="M13 25.5c2 2.6 12 2.6 14 0" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/><rect x="18" y="-1" width="4" height="5" rx="2" fill="#ff8a3d"/></svg>';
const GRIDDY_SUGG = ['Check my account for problems', 'How do I connect Gmail?', 'Is cold emailing businesses legal in the UK?', 'How do I stop emails going to junk?', 'What are merge fields?'];
const griddy = { open: false, busy: false, log: [], mounted: false };

function griddyMount(show) {
  const root = document.getElementById('griddy-root');
  if (!root) return;
  if (!show) { root.innerHTML = ''; griddy.mounted = false; griddy.open = false; griddy.log = []; return; }
  if (griddy.mounted) return;
  griddy.mounted = true;
  root.innerHTML = `<button id="griddy-btn" type="button" data-act="griddyOpen" aria-expanded="false" aria-controls="griddy">${GRIDDY_FACE}Ask Griddy</button>
<section id="griddy" role="dialog" aria-label="Griddy helper" hidden>
  <div class="g-head">${GRIDDY_FACE}<div><strong>Griddy</strong><span>Your Gridline.io helper</span></div><button type="button" data-act="griddyClose" aria-label="Close Griddy">×</button></div>
  <div class="g-log" id="g-log" aria-live="polite"></div>
  <form class="g-form" data-form="griddyAsk"><input type="text" name="q" placeholder="Ask Griddy anything…" autocomplete="off" maxlength="1000" aria-label="Your question"><button class="btn primary" type="submit">Send</button></form>
  <div class="g-foot" id="g-foot"></div>
</section>`;
}
function griddyDraw() {
  const log = document.getElementById('g-log');
  if (!log) return;
  const hello = `${tzNow().greet}, ${firstName()}! I'm Griddy. Ask me how to do anything in Gridline.io, or ask me to check your account for anything stopping your emails.`;
  log.innerHTML = html`<div class="g-msg bot">${hello}</div>
${griddy.log.length ? '' : html`<div class="g-sugg">${GRIDDY_SUGG.map((q) => html`<button type="button" data-act="griddySugg" data-q="${q}">${q}</button>`)}</div>`}
${griddy.log.map((m) => html`<div class="g-msg ${m.role === 'user' ? 'me' : 'bot'}">${m.content}</div>`)}
${griddy.busy ? html`<div class="g-msg bot typing">Griddy is thinking…</div>` : ''}`.__html;
  log.scrollTop = log.scrollHeight;
  const foot = document.getElementById('g-foot');
  if (foot) foot.textContent = state.me && state.me.griddy_ai ? 'Griddy uses AI and can make mistakes. It never sees your leads or emails.' : 'Answers from the Gridline.io guide and a live check of your account.';
}
function griddyToggle(open) {
  griddy.open = open;
  const panel = document.getElementById('griddy'), btn = document.getElementById('griddy-btn');
  if (!panel) return;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) { griddyDraw(); panel.querySelector('input').focus(); } else btn.focus();
}
acts.griddyOpen = () => griddyToggle(!griddy.open);
acts.griddyClose = () => griddyToggle(false);
async function griddyAsk(q) {
  q = String(q || '').trim();
  if (!q || griddy.busy) return;
  griddy.log.push({ role: 'user', content: q });
  griddy.busy = true; griddyDraw();
  try {
    const r = await post('/api/griddy', { messages: griddy.log, page: currentPage });
    griddy.log.push({ role: 'assistant', content: r.answer });
  } catch (e) {
    griddy.log.push({ role: 'assistant', content: 'Sorry, I couldn\'t answer that just now. Please try again in a moment.' });
  } finally { griddy.busy = false; griddyDraw(); }
}
acts.griddySugg = (el) => griddyAsk(el.dataset.q);
forms.griddyAsk = async (f, d) => { f.reset(); await griddyAsk(d.q); f.querySelector('input').focus(); };


/* ------------------------------------------------------------------ */
/* Plan & billing, team, joining by invite                             */
/* ------------------------------------------------------------------ */

let billingThanked = false;
let seatCount = 0;
const money = (n) => '£' + Number(n).toFixed(2);
const lim = (n, unit) => (n === null ? `Unlimited ${unit}` : `${n.toLocaleString('en-GB')} ${unit}`);

async function billingTab() {
  const b = await api('/api/billing');
  const p = b.plan, L = b.limits, owner = state.me.role === 'owner';
  const proTotal = b.prices.pro + seatCount * b.prices.seat;
  const current = (k) => (p.paid ? p.plan === k : k === 'trial');
  const status = p.paid
    ? html`<div class="notice good">You're on <strong>${p.label}</strong>${p.plan === 'pro' ? html` with ${p.seats} user${p.seats === 1 ? '' : 's'}` : ''}.${p.period_end ? html` Next payment ${new Date(p.period_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.` : ''}</div>`
    : p.locked ? html`<div class="notice">${p.locked}</div>`
    : html`<div class="notice info">You're on the free trial: ${p.trial_days_left} day${p.trial_days_left === 1 ? '' : 's'} and ${Math.max(0, p.emails_limit - p.emails_used)} emails left. Pick a plan any time; nothing is lost when you upgrade.</div>`;
  const notReady = !b.ready && !b.sandbox ? html`<div class="notice small">Payments aren't connected yet. The owner of this Gridline.io installation needs to add Stripe keys (see the launch guide).</div>` : '';
  const proCard = html`<div class="plan-card ${current('pro') ? 'current' : ''} featured"><div class="pc-tag">Most popular</div>
<h3>Pro</h3><div class="pc-price"><strong>${money(b.prices.pro)}</strong><span>/month</span></div><p class="small muted">Everything unlocked for 1 user.</p>
<ul><li>Unlimited emails (within safe daily limits)</li><li>${L.pro.inboxesPerUser} inboxes per user</li><li>${lim(L.pro.leads, 'leads')}</li><li>Calls, replies, growth signals, Griddy</li><li>Extra users ${money(b.prices.seat)}/month each</li></ul>
${p.paid && p.plan === 'pro' ? html`<div class="seats"><span>Extra users</span><div class="stepper"><button type="button" class="btn small" data-act="seatStep" data-d="-1" aria-label="One fewer user" ${owner ? '' : 'disabled'}>−</button><output id="seatOut">${p.extra_seats}</output><button type="button" class="btn small" data-act="seatStep" data-d="1" aria-label="One more user" ${owner ? '' : 'disabled'}>+</button></div></div>
<p class="small muted" style="margin:0">Total ${money(b.prices.pro + p.extra_seats * b.prices.seat)}/month for ${p.seats} user${p.seats === 1 ? '' : 's'}. Changes are prorated.</p>`
    : p.paid ? '' : html`<div class="seats"><span>Extra users</span><div class="stepper"><button type="button" class="btn small" data-act="seatPick" data-d="-1" aria-label="One fewer user">−</button><output>${seatCount}</output><button type="button" class="btn small" data-act="seatPick" data-d="1" aria-label="One more user">+</button></div></div>
<p class="small muted" style="margin:0"><strong>${money(proTotal)}/month</strong> for ${1 + seatCount} user${seatCount ? 's' : ''}</p>`}
${p.paid ? '' : html`<button class="btn primary" data-act="checkout" data-plan="pro" ${owner ? '' : 'disabled'}>Choose Pro</button>`}</div>`;
  const entCard = html`<div class="plan-card ${current('enterprise') ? 'current' : ''}">
<h3>Enterprise</h3><div class="pc-price"><strong>${money(b.prices.enterprise)}</strong><span>/month</span></div><p class="small muted">For teams. Cheaper than Pro from 10 users.</p>
<ul><li>Unlimited users</li><li>Unlimited inboxes</li><li>Unlimited leads</li><li>Everything in Pro</li><li>More Griddy AI answers and priority support</li></ul>
${p.paid ? '' : html`<button class="btn dark" data-act="checkout" data-plan="enterprise" ${owner ? '' : 'disabled'}>Choose Enterprise</button>`}</div>`;
  const trialCard = html`<div class="plan-card ${current('trial') && !p.locked ? 'current' : ''}">
<h3>Free trial</h3><div class="pc-price"><strong>£0</strong><span>for ${L.trial.days} days</span></div><p class="small muted">Try everything with a few limits.</p>
<ul><li>${L.trial.emails} emails</li><li>1 user, 1 inbox</li><li>${L.trial.leads} leads</li><li>All features included</li></ul></div>`;
  return html`<section class="stack">${status}${notReady}
${owner ? '' : html`<div class="notice info small">Only the account owner can change the plan.</div>`}
<div class="plan-grid">${trialCard}${proCard}${entCard}</div>
${p.paid ? html`<div class="card row between"><div><h2>Billing</h2><p class="sub">Update your card, download invoices, switch plans or cancel. Handled securely by Stripe.</p></div><button class="btn" data-act="billingPortal" ${owner ? '' : 'disabled'}>Manage billing</button></div>` : ''}
<p class="small muted">Prices are per month. Cancel any time; you keep access until the end of the month you've paid for. Card payments are handled by Stripe. Gridline.io never sees your card details.</p></section>`;
}
acts.seatPick = (el) => { seatCount = Math.max(0, Math.min(50, seatCount + Number(el.dataset.d))); rerender(); };
let seatTimer;
acts.seatStep = (el) => {
  const out = document.getElementById('seatOut');
  const n = Math.max(0, Math.min(50, Number(out.textContent) + Number(el.dataset.d)));
  out.textContent = n;
  clearTimeout(seatTimer);
  seatTimer = setTimeout(async () => {
    try { await post('/api/billing/seats', { extra_seats: n }); await refreshMe(); toast('Users updated.'); } catch (e) { toast(e.message, true); }
    rerender();
  }, 900);
};
acts.checkout = async (el) => {
  el.disabled = true;
  try {
    const r = await post('/api/billing/checkout', { plan: el.dataset.plan, extra_seats: seatCount });
    if (r.url.startsWith('#')) { await refreshMe(); go(r.url); } else location.href = r.url;
  } finally { el.disabled = false; }
};
acts.billingPortal = async () => {
  const r = await post('/api/billing/portal');
  if (r.note) toast(r.note);
  if (r.url.startsWith('#')) { await refreshMe(); go(r.url); } else location.href = r.url;
};

async function teamTab() {
  const t = await api('/api/team');
  const p = t.plan, owner = state.me.role === 'owner';
  const used = p.users + p.pending_invites;
  const seatsText = p.seats === null ? 'Unlimited users' : `${used} of ${p.seats} user${p.seats === 1 ? '' : 's'} used`;
  return html`<section class="stack"><div class="card stack"><div class="row between"><div><h2>Your team</h2><p class="sub">Everyone shares the same leads, campaigns, inboxes and Do Not Contact list.</p></div><span class="badge b-blue">${seatsText}</span></div>
<div class="list">${t.users.map((u) => html`<div class="list-item row between"><div><strong>${u.name}</strong> <span class="badge ${u.role === 'owner' ? 'b-hot' : ''}">${u.role === 'owner' ? 'Owner' : 'Member'}</span><div class="small muted">${u.email}</div></div>
${owner && u.role !== 'owner' ? html`<button class="btn small danger" data-act="removeUser" data-id="${u.id}" data-name="${u.name}">Remove</button>` : ''}</div>`)}
${t.invites.map((i) => html`<div class="list-item row between"><div><strong>${i.email}</strong> <span class="badge b-warn">Invited</span><div class="small muted">Invite expires ${when(i.expires_at)}</div></div>${owner ? html`<button class="btn small" data-act="cancelInvite" data-id="${i.id}">Cancel invite</button>` : ''}</div>`)}</div></div>
${owner ? html`<form data-form="invite" class="card stack"><div><h2>Invite someone</h2><p class="sub">We'll create a private link for you to send them. It works for 7 days.${p.plan === 'pro' ? ` Each extra user is £9.99 a month. Add users in Plan & billing.` : p.plan === 'trial' ? ' The free trial includes 1 user. Upgrade to add your team.' : ''}</p></div>
<div class="error-box form-error" hidden></div><div class="row"><label class="field" style="flex:1 1 260px">Their email<input type="email" name="email" required></label></div>
<div class="row"><button class="btn primary" type="submit">Create invite link</button></div><div id="inviteOut"></div></form>` : ''}</section>`;
}
forms.invite = async (f, d) => {
  const r = await post('/api/team/invite', d);
  const link = r.link.startsWith('http') ? r.link : location.origin + r.link;
  await rerender();
  const out = document.getElementById('inviteOut');
  if (out) out.innerHTML = html`<div class="notice good stack small"><span>Invite created. Send this link to <strong>${d.email}</strong>:</span><input type="text" readonly value="${link}" aria-label="Invite link"><button type="button" class="btn small" data-act="copyLink" data-v="${link}">Copy link</button></div>`.__html;
};
acts.copyLink = async (el) => { try { await navigator.clipboard.writeText(el.dataset.v); toast('Link copied.'); } catch (e) { toast('Select the link and copy it.'); } };
acts.cancelInvite = async (el) => { await del('/api/team/invites/' + el.dataset.id); rerender(); };
acts.removeUser = (el) => confirmBox(`Remove ${el.dataset.name}?`, "They'll lose access straight away. Their work stays in the account.", 'Remove', async () => { await del('/api/team/users/' + el.dataset.id); toast('Removed.'); rerender(); });

async function joinPage(token) {
  let inv;
  try { inv = await api('/api/join/' + encodeURIComponent(token || ''), { allow401: true }); } catch (e) {
    return html`<div class="auth"><div class="auth-box"><span class="brand">Gridline<span style="color:var(--orange)">.io</span></span><div class="error-box">${e.message}</div><a href="#/login">Go to log in</a></div></div>`;
  }
  return html`<div class="auth"><form class="auth-box" data-form="join"><input type="hidden" name="token" value="${token}">
  <span class="brand">Gridline<span style="color:var(--orange)">.io</span></span>
  <h1 style="font-size:22px">Join ${inv.workspace}</h1><p class="auth-pitch">You've been invited as <strong>${inv.email}</strong>.</p>
  <div class="error-box form-error" hidden></div>
  <label class="field">Your name<input type="text" name="name" autocomplete="name" required></label>
  <label class="field">Choose a password<span class="hint">At least 10 characters</span><input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
  <button class="btn primary" type="submit">Join</button></form></div>`;
}
forms.join = async (f, d) => { await post('/api/join/' + encodeURIComponent(d.token), d); await refreshMe(); go('#/dashboard'); toast('Welcome to the team!'); };

render();
