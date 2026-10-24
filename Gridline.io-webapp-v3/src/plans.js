'use strict';
// Plans, prices and limits. Change the numbers here to change what each plan includes.
// Prices are shown in the app; the amount actually charged is set on the matching Stripe price.

const DAY = 86400000;
const INF = Infinity;

const PLANS = {
  trial: {
    label: 'Free trial', price: 0, days: 7,
    users: 1, inboxesPerUser: 1, inboxesMax: 1, emails: 100, leads: 200, griddyAiPerDay: 15
  },
  pro: {
    label: 'Pro', price: 19.99, seatPrice: 9.99,
    users: null /* 1 + extra seats bought */, inboxesPerUser: 3, inboxesMax: INF, emails: INF, leads: 25000, griddyAiPerDay: 40
  },
  enterprise: {
    label: 'Enterprise', price: 109.99,
    users: INF, inboxesPerUser: INF, inboxesMax: INF, emails: INF, leads: INF, griddyAiPerDay: 150
  }
};

// The live state of a workspace's plan, with everything the app needs to enforce it.
function status(db, ws, now = Date.now()) {
  const users = db.get('SELECT COUNT(*) n FROM users WHERE workspace_id = ?', ws.id).n;
  const pendingInvites = db.get('SELECT COUNT(*) n FROM invites WHERE workspace_id = ? AND expires_at > ?', ws.id, now).n;
  const inboxes = db.get('SELECT COUNT(*) n FROM inboxes WHERE workspace_id = ?', ws.id).n;
  const leads = db.get('SELECT COUNT(*) n FROM leads WHERE workspace_id = ?', ws.id).n;
  const paid = (ws.plan === 'pro' || ws.plan === 'enterprise') && ['active', 'trialing', 'past_due'].includes(ws.sub_status || 'active');
  const plan = paid ? ws.plan : 'trial';
  const p = PLANS[plan];
  const trialEnds = ws.trial_ends_at != null ? ws.trial_ends_at : ws.created_at + PLANS.trial.days * DAY;
  const emailsSent = plan === 'trial' ? db.get(`SELECT COUNT(*) n FROM messages WHERE workspace_id = ? AND direction = 'out' AND step_position IS NOT NULL`, ws.id).n : 0;
  const trialExpired = !paid && now >= trialEnds;
  const trialUsedUp = !paid && emailsSent >= PLANS.trial.emails;
  const seats = plan === 'pro' ? 1 + (ws.extra_seats || 0) : p.users;
  const inboxLimit = Math.min(p.inboxesMax, p.inboxesPerUser * (Number.isFinite(seats) ? seats : 1e9));
  let locked = '';
  if (trialExpired && ws.sub_status === 'canceled') locked = 'Your subscription has ended. Choose a plan to carry on sending.';
  else if (trialExpired) locked = 'Your free trial has ended. Choose a plan to carry on sending.';
  else if (trialUsedUp) locked = `You've used all ${PLANS.trial.emails} trial emails. Choose a plan to carry on sending.`;
  return {
    plan, label: p.label, paid, sub_status: ws.sub_status || '', past_due: ws.sub_status === 'past_due',
    trial_ends_at: paid ? null : trialEnds,
    trial_days_left: paid ? null : Math.max(0, Math.ceil((trialEnds - now) / DAY)),
    emails_used: emailsSent, emails_limit: p.emails, users, pending_invites: pendingInvites, seats,
    extra_seats: ws.extra_seats || 0, inboxes, inbox_limit: inboxLimit, leads, lead_limit: p.leads,
    period_end: ws.period_end || null, can_send: !locked, locked,
    has_billing_account: !!ws.stripe_customer_id
  };
}

const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString('en-GB') : 'unlimited');
class LimitError extends Error { constructor(msg) { super(msg); this.status = 402; } }

function check(db, ws, what, adding = 1) {
  const s = status(db, ws);
  const upgrade = s.plan === 'trial' ? ' Upgrade to Pro or Enterprise to add more.' : s.plan === 'pro' ? ' Add another user or move to Enterprise for more.' : '';
  if (what === 'send' && !s.can_send) throw new LimitError(s.locked);
  if (what === 'inbox' && s.inboxes + adding > s.inbox_limit) throw new LimitError(`Your ${s.label} plan includes ${fmt(s.inbox_limit)} inbox${s.inbox_limit === 1 ? '' : 'es'}.${upgrade}`);
  if (what === 'lead' && s.leads + adding > s.lead_limit) throw new LimitError(`Your ${s.label} plan includes up to ${fmt(s.lead_limit)} leads. You have ${fmt(s.leads)}.${upgrade}`);
  if (what === 'user' && s.users + s.pending_invites + adding > s.seats) throw new LimitError(`Your ${s.label} plan has ${fmt(s.seats)} user${s.seats === 1 ? '' : 's'}.${s.plan === 'pro' ? ' Add an extra user for £9.99 a month in Settings → Plan & billing.' : upgrade}`);
  return s;
}

// How many leads can still be added (for imports).
function leadRoom(db, ws) { const s = status(db, ws); return Math.max(0, s.lead_limit - s.leads); }

module.exports = { PLANS, status, check, leadRoom, LimitError, DAY };
