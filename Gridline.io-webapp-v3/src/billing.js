'use strict';
// Stripe billing without any packages: Checkout for sign-up, the Customer Portal for
// cards/invoices/cancelling, and a signed webhook to keep each workspace's plan in sync.
const crypto = require('node:crypto');

function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}

class Stripe {
  constructor({ secretKey, prices, webhookSecret, fetchImpl }) {
    this.key = secretKey; this.prices = prices; this.webhookSecret = webhookSecret; this.fetch = fetchImpl || fetch;
  }
  get configured() { return !!(this.key && this.prices.pro && this.prices.seat && this.prices.enterprise); }

  async call(method, path, params) {
    const res = await this.fetch('https://api.stripe.com/v1' + path, {
      method,
      headers: { Authorization: 'Bearer ' + this.key, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2024-06-20' },
      body: params && method !== 'GET' ? form(params) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Payment provider error.');
    return data;
  }

  checkout({ ws, email, plan, extraSeats, appUrl }) {
    const items = plan === 'enterprise'
      ? [{ price: this.prices.enterprise, quantity: 1 }]
      : [{ price: this.prices.pro, quantity: 1 }, ...(extraSeats > 0 ? [{ price: this.prices.seat, quantity: extraSeats }] : [])];
    return this.call('POST', '/checkout/sessions', {
      mode: 'subscription',
      line_items: items,
      success_url: `${appUrl}/#/settings/billing?paid=1`,
      cancel_url: `${appUrl}/#/settings/billing`,
      client_reference_id: String(ws.id),
      ...(ws.stripe_customer_id ? { customer: ws.stripe_customer_id } : { customer_email: email }),
      allow_promotion_codes: 'true',
      billing_address_collection: 'auto',
      metadata: { workspace_id: String(ws.id) },
      subscription_data: { metadata: { workspace_id: String(ws.id) } }
    });
  }

  portal({ ws, appUrl }) {
    return this.call('POST', '/billing_portal/sessions', { customer: ws.stripe_customer_id, return_url: `${appUrl}/#/settings/billing` });
  }

  // Change the number of extra users on a Pro subscription (prorated by Stripe).
  async setSeats(ws, extraSeats) {
    const sub = await this.call('GET', `/subscriptions/${ws.stripe_subscription_id}`);
    const item = sub.items.data.find((i) => i.price.id === this.prices.seat);
    if (item && extraSeats > 0) await this.call('POST', `/subscription_items/${item.id}`, { quantity: extraSeats, proration_behavior: 'create_prorations' });
    else if (item) await this.call('DELETE', `/subscription_items/${item.id}`, { proration_behavior: 'create_prorations' });
    else if (extraSeats > 0) await this.call('POST', '/subscription_items', { subscription: sub.id, price: this.prices.seat, quantity: extraSeats, proration_behavior: 'create_prorations' });
    return this.call('GET', `/subscriptions/${sub.id}`);
  }

  // Check Stripe's signature so nobody can fake a "paid" message.
  verify(rawBody, header) {
    if (!this.webhookSecret) throw new Error('Webhook secret not set.');
    const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v]));
    const sigs = String(header || '').split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
    const t = Number(parts.t);
    if (!t || !sigs.length) throw new Error('Bad signature header.');
    if (Math.abs(Date.now() / 1000 - t) > 300) throw new Error('Signature too old.');
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(`${t}.${rawBody}`).digest('hex');
    const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
    if (!ok) throw new Error('Signature mismatch.');
    return JSON.parse(rawBody);
  }

  // Turn a Stripe subscription into the fields we store on the workspace.
  planFromSubscription(sub) {
    const items = (sub.items && sub.items.data) || [];
    const has = (price) => items.find((i) => i.price && i.price.id === price);
    const plan = has(this.prices.enterprise) ? 'enterprise' : has(this.prices.pro) ? 'pro' : 'trial';
    const seat = has(this.prices.seat);
    return {
      plan, extra_seats: seat ? seat.quantity : 0, sub_status: sub.status,
      stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || '',
      stripe_subscription_id: sub.id,
      period_end: (sub.current_period_end || (items[0] && items[0].current_period_end) || 0) * 1000 || null
    };
  }
}

module.exports = { Stripe, form };
