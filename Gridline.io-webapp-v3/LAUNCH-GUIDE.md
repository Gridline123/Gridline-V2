# Gridline.io – Launch Guide

Gridline.io is a web app for UK businesses that win work on the phone. It finds companies that are hiring, emails them safely from your own inbox, and tells you who to ring each morning.

It uses **no third-party packages**, only what's built into Node.js. There's nothing extra to install or keep patched.

---

## 1. Try it on your own computer (optional, 5 minutes)

1. Install **Node.js 22.13 or newer** from nodejs.org.
2. Unzip Gridline.io, open a terminal in the folder, and run:

   ```
   APP_SECRET=any-long-random-text-here SANDBOX=1 npm start
   ```

   On Windows PowerShell:

   ```
   $env:APP_SECRET="any-long-random-text-here"; $env:SANDBOX="1"; npm start
   ```

3. Open **http://localhost:3000** and create an account.

`SANDBOX=1` means everything works but **no real emails are sent**. It's good for trying it out and for demos. Remove it to send for real.

## 2. Put it online

### Option A: Render (about $7 a month)

1. Put the files in a **private** GitHub repository (see Railway step 2 below).
2. Sign up at **render.com** with your GitHub account.
3. Click **New → Blueprint**, choose your `gridline-io` repository, and click **Apply**. The included `render.yaml` sets up the app, 1 GB of storage at `/data`, a random `APP_SECRET`, and sandbox mode.
4. When it shows **Live**, open the `onrender.com` address and create your account.
5. To go live, delete `SANDBOX` under **Environment**. If you add your own domain later, set `APP_URL` to it.

The setup uses Render's Starter plan, because the free plan goes to sleep and can't keep data.

### Option B: Railway (about £4–£5 a month)

1. Create a free account at **railway.com** and a free account at **github.com**.
2. On GitHub, create a **private** repository called `gridline-io` and upload all the files from this folder.
3. In Railway: **New Project → Deploy from GitHub repo → gridline-io**.
4. In the service, open **Settings → Volumes → Add volume**, and mount it at `/data`. This is where your database lives. Without it, data is lost when Railway restarts.
5. Open **Variables** and add:

   | Variable | Value |
   |---|---|
   | `APP_SECRET` | A long random string, 40+ characters. **Keep it safe and never change it**: it encrypts saved inbox passwords. |
   | `DATABASE_PATH` | `/data/gridline.db` |
   | `APP_URL` | Your app's address, e.g. `https://app.gridline.io` (or the Railway address at first) |
   | `SANDBOX` | `1` while testing. Delete this variable to go live. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_SEAT`, `STRIPE_PRICE_ENTERPRISE` | For taking payments. See section 6. |
| `GRIDDY_API_KEY` | *Optional.* An Anthropic API key from console.anthropic.com. Leave it out and Griddy still works for free from its built-in guide. |
| `GRIDDY_DAILY_LIMIT` | *Optional.* The most AI answers per customer per day (default 40), which caps your costs. |

6. Under **Settings → Networking**, click **Generate Domain**, or add your own domain such as `app.gridline.io`.
7. Open the address, create your account, and fill in **Settings → Compliance**.

Railway's prices change from time to time, so check their current plans. A single small app like this usually fits within the cheapest paid plan.

## 3. Connect your first inbox

**Gmail / Google Workspace**
1. Turn on **2-Step Verification** for the Google account.
2. Go to **myaccount.google.com/apppasswords**, create an app password named "Gridline.io", and copy the 16 characters.
3. In Gridline.io: **Settings → Inboxes → Connect an inbox**, choose Gmail, and paste the app password.

On Google Workspace, an admin may need to allow app passwords for your users.

**Other providers:** Zoho and Fastmail are built in. Any provider that offers SMTP and IMAP with an app password works through **Other**.

**Outlook / Microsoft 365 isn't supported yet.** Microsoft has switched off app passwords for most accounts, so it needs a separate connection method (planned).

## 4. Your first campaign

1. **Leads → Import CSV.** Match the columns, and say where the contacts came from.
2. **Campaigns → New campaign.** Edit the 4-step sequence (email, call, email, email).
3. Fill in the **Legitimate interest** tab (three short answers).
4. **Leads tab → Add all new leads**, then **Send test to me** and **Launch**.

Gridline.io checks for due emails every minute and for replies every few minutes.

## 5. Griddy, the built-in helper

Every page has an **Ask Griddy** button in the bottom-right corner. Griddy answers questions about using Gridline.io, deliverability and UK outreach rules. Ask it "check my account" or "why aren't my emails sending?" and it checks the account for missing details, disconnected inboxes, paused campaigns, held leads or sending outside sending hours.

- **Free mode (default):** answers from a built-in guide plus the live account check. No running cost.
- **AI mode:** add `GRIDDY_API_KEY` and Griddy uses Claude Haiku for fuller, conversational answers. Each answer typically costs well under 1p (check Anthropic's current prices), and `GRIDDY_DAILY_LIMIT` caps each customer per day. When the limit is reached or the AI is unavailable, Griddy falls back to free mode. Griddy only shares counts and setup status with the AI, never lead names, email addresses or message content.

## 6. Taking payments (Stripe)

**Plans built into the app**

| Plan | Price | Includes |
|---|---|---|
| Free trial | £0 for 7 days | 100 emails, 1 user, 1 inbox, 200 leads, every feature |
| Pro | £19.99/month | 1 user, unlimited emails (within safe daily limits), 3 inboxes per user, 25,000 leads |
| Extra Pro user | £9.99/month each | Each one adds a team seat (and 3 more inboxes) |
| Enterprise | £109.99/month | Unlimited users, inboxes and leads, more Griddy AI answers |

To change any limit, edit `src/plans.js`. To change a price, change it in Stripe **and** in `src/plans.js` (that file sets what the app displays).

When a trial ends or uses its 100 emails, **sending pauses** but nothing is deleted. Customers can still log in, read replies, handle opt-outs and export their data, and they pick up where they left off when they pay. A cancelled subscription keeps working until the end of the paid month.

**Set up Stripe (no monthly fee, you pay a small fee per payment)**

1. Create an account at **stripe.com** and complete the business details. Stay in **Test mode** for now.
2. **Product catalogue → Add product**, three times, each with a **recurring monthly** price in GBP:
   - "Gridline.io Pro" at £19.99
   - "Gridline.io extra user" at £9.99
   - "Gridline.io Enterprise" at £109.99
   
   Copy each **price ID** (starts `price_`) into `STRIPE_PRICE_PRO`, `STRIPE_PRICE_SEAT` and `STRIPE_PRICE_ENTERPRISE`.
3. **Developers → API keys:** copy the **secret key** (`sk_test_…`) into `STRIPE_SECRET_KEY`.
4. **Developers → Webhooks → Add endpoint:** URL `https://YOUR-APP-ADDRESS/api/stripe/webhook`. Select the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`. Copy the **signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
5. **Settings → Billing → Customer portal:** turn it on, and allow customers to update payment methods, view invoices and cancel.
6. Test it with Stripe's test card `4242 4242 4242 4242`, any future date and any CVC. When it all works, switch Stripe to **Live mode** and repeat steps 2–4 with the live keys.

Without Stripe keys, sandbox mode (`SANDBOX=1`) shows a demo checkout that switches plans instantly, which is useful for trying it out and for demos.

**Good to know**
- Card details go straight to Stripe. Gridline.io never sees or stores them.
- Stripe's UK card fees are a small percentage plus a few pence per payment; check stripe.com/gb/pricing for current rates.
- If you register for VAT, turn on Stripe Tax or set your prices to include VAT. Ask an accountant which applies to you.

## 7. Team members

The account owner invites people in **Settings → Team**. Gridline.io creates a private invite link (valid 7 days) to send them. Members share leads, campaigns and inboxes. Only the owner can manage billing and the team. Seats are enforced: Pro allows 1 + the extra users paid for, and Enterprise is unlimited.

## 8. Growth signals (optional)

1. Create a free developer account at **developer.adzuna.com**.
2. Copy your App ID and App Key into **Settings → Growth signals**.
3. Search for job titles in your area. Each hiring company becomes a lead with a ready-made opening line.

---

## What's built

| Area | Included |
|---|---|
| Accounts | Sign-up, login, secure sessions, encrypted inbox passwords |
| Sending | Your own inboxes via SMTP, several inboxes per campaign, daily limits with ramp-up, sending days and hours, randomised gaps between emails, follow-ups in the same thread |
| Email + phone | Call steps in sequences, a daily call list with scripts, one-click call outcomes that update the sequence |
| Replies | Reads replies via IMAP, stops the sequence, labels each reply (interested, question, not interested, opted out, out of office), books a call-back, and lets you reply in the same thread |
| Compliance | Required business details, a one-click unsubscribe link on every email, a privacy line in the first email (with the contact's source), personal-address blocking without consent, a legitimate interest record per campaign, a shared Do Not Contact list, automatic opt-out and bounce handling, GDPR erasure, data retention, and a full audit log export |
| Safety | Holds any email with a missing name or broken merge field, one new email per company per day, pauses inboxes that fail to log in |
| Growth signals | Live UK job adverts via Adzuna, grouped by company, turned into leads |
| Griddy helper | In-app chat assistant with a live account check. Free guide mode, or optional AI mode |
| Plans & billing | 7-day free trial with limits, Pro, extra users and Enterprise via Stripe Checkout, self-serve billing portal, signed webhooks |
| Team | Invite links, owner and member roles, seat limits per plan |
| Display | Light, dark or match-device theme (saved per user), and a live greeting, date and clock in the workspace time zone |

## Planned next (stage 3)

- **Password reset** by email (sent from your own Gridline.io address)
- **Outlook / Microsoft 365** connection
- Optional **AI-written opening lines** for each lead
- A hosted **status page** and automatic backups

## Running tests

```
npm test
```

These run the sending engine, compliance guard, reply handling, and the SMTP and IMAP connections against local test mail servers.
