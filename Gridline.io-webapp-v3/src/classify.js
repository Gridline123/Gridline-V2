'use strict';
// Sorts incoming mail: bounce, out-of-office, opt-out, not interested, interested, question, other.

const OPT_OUT = /\b(unsubscribe|remove me|remove us|take me off|take us off|stop (e-?mailing|contacting|sending)|do not (contact|email)|don'?t (contact|email)|opt(ed)? out|no more emails)\b/i;
const NOT_INTERESTED = /\b(not interested|no thanks|no thank you|not for us|not at (the|this) moment|not right now|we'?re (all )?sorted|we don'?t use|not looking|no need|not required|we'?re covered|already have)\b/i;
const INTERESTED = /\b(interested|call me|give me a (call|ring|bell)|ring me|phone me|send (me |us |over )?(the |some |more )?(details|info|information|profile|cv|pricing|prices|rates)|tell me more|sounds (good|great|interesting|useful)|let'?s (talk|chat|speak|meet)|happy to (talk|chat|speak|meet)|when are you free|book (a|in)|arrange a (call|meeting)|(are|is) (he|she|they) available|yes please)\b/i;
const OOO = /\b(out of (the )?office|automatic reply|auto-?reply|autoreply|annual leave|on (holiday|vacation|leave)|away from (my|the) (desk|office)|limited access to (my )?e-?mail|returning on|back in the office)\b/i;
const BOUNCE_FROM = /(mailer-daemon|postmaster|mail delivery (sub)?system)/i;
const BOUNCE_SUBJECT = /(undeliver|delivery (status )?notification|delivery has failed|failure notice|returned mail|could not be delivered|delivery failure|address not found)/i;

function isBounce(msg) {
  const h = msg.headers || {};
  if (h['x-failed-recipients']) return true;
  if (/report-type\s*=\s*"?delivery-status/i.test(h['content-type'] || '')) return true;
  return BOUNCE_FROM.test(msg.fromRaw || msg.from || '') && BOUNCE_SUBJECT.test(msg.subject || '') ||
    (BOUNCE_FROM.test(msg.fromRaw || msg.from || '') && /final-recipient/i.test(msg.text || ''));
}

function bouncedAddresses(msg) {
  const h = msg.headers || {};
  const found = new Set();
  const add = (s) => (String(s || '').toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []).forEach((e) => found.add(e));
  add(h['x-failed-recipients']);
  const fr = String(msg.text || '').match(/final-recipient:[^\n]*/gi) || [];
  fr.forEach(add);
  if (!found.size) add(msg.text);
  return [...found];
}

function isAutoReply(msg) {
  const h = msg.headers || {};
  const auto = String(h['auto-submitted'] || '').toLowerCase();
  if (auto && auto !== 'no') return true;
  if (h['x-autoreply'] || h['x-autorespond'] || /auto[_-]?reply/i.test(h['x-auto-response-suppress'] || '')) return true;
  if (/^(auto|bulk|junk)$/i.test(String(h.precedence || '').trim())) return true;
  return OOO.test(msg.subject || '') || OOO.test(String(msg.reply || '').slice(0, 600));
}

function classify(msg) {
  if (isBounce(msg)) return 'bounce';
  if (isAutoReply(msg)) return 'ooo';
  const t = (msg.reply || msg.text || '').slice(0, 2000);
  if (OPT_OUT.test(t)) return 'opted_out';
  if (NOT_INTERESTED.test(t)) return 'not_interested';
  if (INTERESTED.test(t)) return 'interested';
  if (/\?/.test(t)) return 'question';
  return 'other';
}

module.exports = { classify, isBounce, bouncedAddresses, isAutoReply };
