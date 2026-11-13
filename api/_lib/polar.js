'use strict';
// Paid plans through Polar (merchant of record), the payment account for every Silit Labs product.
// Env: POLAR_ACCESS_TOKEN (organization access token), POLAR_WEBHOOK_SECRET (whsec_...),
//      POLAR_API_BASE (optional; https://sandbox-api.polar.sh for the sandbox), POLAR_PORTAL_URL (optional fallback)
// Token scopes: products:read, checkouts:write, subscriptions:read, subscriptions:write, customer_sessions:write
// The Polar organization also sells other products, so only products whose name contains "Flowdeck" are used.
// Each is matched to a plan by its metadata "plan" (solo, studio, agency) or its name, and to monthly or yearly
// by its billing interval.
const crypto = require('crypto');

const API_VERSION = '2026-10';
const TOLERANCE_S = 300; // Standard Webhooks: refuse signatures older or newer than 5 minutes

// Polar statuses in the words the rest of the app uses (the Lemon Squeezy ones), so the plan panel,
// hasLiveSubscription and the one-subscription rule work the same for both providers.
function normStatus(sub) {
  const s = String(sub.status || '');
  if (s === 'active' && sub.cancel_at_period_end) return 'cancelled'; // still active until the period ends
  if (s === 'trialing') return 'on_trial';
  if (s === 'canceled') return 'expired'; // Polar "canceled" means it has ended
  return s; // active, past_due, unpaid, paused, incomplete, incomplete_expired
}

module.exports = function polarProvider({ PLANS, ACTIVE, sign, isTester, kv }) {
  function cfg() {
    return {
      token: String(process.env.POLAR_ACCESS_TOKEN || '').trim(),
      secret: String(process.env.POLAR_WEBHOOK_SECRET || '').trim(),
      base: (process.env.POLAR_API_BASE || 'https://api.polar.sh').trim().replace(/\/+$/, ''),
      portal: String(process.env.POLAR_PORTAL_URL || 'https://polar.sh/silitlabs/portal').trim()
    };
  }
  function enabled() { return !!cfg().token; }
  function isSandbox() { return /sandbox/i.test(cfg().base); }

  async function api(method, path, body) {
    const c = cfg();
    const res = await fetch(c.base + path, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token, 'Polar-Version': API_VERSION },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      let msg = data && data.detail;
      if (Array.isArray(msg)) msg = msg.map((d) => (Array.isArray(d.loc) ? d.loc.slice(1).join('.') + ': ' : '') + d.msg).join('; ');
      throw Object.assign(new Error('Polar: ' + (msg || (data && data.error) || res.status)), { status: res.status, code: (data && data.error) || '' });
    }
    return data;
  }

  function planFromProduct(p) {
    if (!p) return null;
    const name = String(p.name || '');
    const meta = p.metadata || {};
    if (!/flowdeck/i.test(name) && String(meta.app || '').toLowerCase() !== 'flowdeck') return null;
    const metaPlan = String(meta.plan || '').trim().toLowerCase();
    const plan = PLANS[metaPlan] ? metaPlan : Object.keys(PLANS).find((k) => name.toLowerCase().includes(k));
    if (!plan) return null;
    const yearly = p.recurring_interval ? p.recurring_interval === 'year' : /year|annual/i.test(name);
    return { plan, interval: yearly ? 'yearly' : 'monthly' };
  }

  let productCache = null;
  async function products() {
    if (productCache && productCache.at > Date.now() - 3600000) return productCache.map;
    const map = {};
    const seen = [];
    for (let page = 1; page <= 5; page++) {
      const d = await api('GET', `/v1/products/?is_archived=false&is_recurring=true&limit=100&page=${page}`);
      for (const p of d.items || []) {
        seen.push(p.name);
        const m = planFromProduct(p);
        if (m && !map[m.plan + ':' + m.interval]) map[m.plan + ':' + m.interval] = p.id;
      }
      if (page >= ((d.pagination && d.pagination.max_page) || 1)) break;
    }
    map._seen = `${seen.length} recurring product(s): ${seen.join('; ') || 'none'}`;
    // Only cache a usable result, so a fix in Polar shows up right away
    if (Object.keys(map).length > 1) productCache = { at: Date.now(), map };
    return map;
  }

  // 'live' when plans can be sold, 'test' in the Polar sandbox (testers only), 'off' otherwise.
  async function mode() {
    if (!enabled()) return 'off';
    try {
      const map = await Promise.race([products(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 4000))]);
      if (!Object.keys(map).some((k) => !k.startsWith('_'))) return 'off';
      return isSandbox() ? 'test' : 'live';
    } catch (e) {
      console.error('[billing] polar mode', e.message);
      return 'off';
    }
  }

  async function checkoutUrl(user, plan, interval, appUrl) {
    if (!PLANS[plan]) throw new Error('Unknown plan');
    interval = interval === 'yearly' ? 'yearly' : 'monthly';
    const map = await products();
    const productId = map[plan + ':' + interval];
    if (!productId) throw new Error(`No ${PLANS[plan].name} ${interval} product found. Polar returned ${map._seen}.`);
    if (isSandbox() && !isTester(user)) throw new Error('Paid plans are not open yet.');
    const body = {
      products: [productId],
      success_url: appUrl + '/app/settings?upgraded=1',
      return_url: appUrl + '/app/settings#plan',
      // copied by Polar to the subscription, so the webhook knows whose plan to change
      metadata: { user_id: String(user.id), sig: sign(user.id), app: 'flowdeck' }
    };
    const email = String((user.settings && user.settings.alertEmail) || user.email || '').trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) body.customer_email = email;
    const d = await api('POST', '/v1/checkouts/', body);
    if (!d.url) throw new Error('Polar did not return a checkout link.');
    return d.url;
  }

  // Standard Webhooks signature. Secrets made before 8 Sep 2026 use the UTF-8 bytes of the whole
  // "whsec_..." string as the key, newer ones the base64-decoded part after "whsec_"; both are tried.
  function signingKeys(secret) {
    const keys = [Buffer.from(secret, 'utf8')];
    const rest = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(rest)) {
      const decoded = Buffer.from(rest, 'base64');
      if (decoded.length && !decoded.equals(keys[0])) keys.push(decoded);
    }
    return keys;
  }
  function verify(raw, headers) {
    const secret = cfg().secret;
    const get = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : headers && headers[k]) || '';
    const id = get('webhook-id'), ts = get('webhook-timestamp'), sigs = get('webhook-signature');
    if (!secret || !id || !ts || !sigs) return false;
    const t = Number(ts);
    if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > TOLERANCE_S) return false;
    const content = `${id}.${Math.floor(t)}.${raw}`;
    const expected = signingKeys(secret).map((k) => crypto.createHmac('sha256', k).update(content).digest());
    for (const part of String(sigs).split(' ')) {
      const i = part.indexOf(',');
      if (i < 0 || part.slice(0, i) !== 'v1') continue;
      const got = Buffer.from(part.slice(i + 1), 'base64');
      if (expected.some((e) => e.length === got.length && crypto.timingSafeEqual(e, got))) return true;
    }
    return false;
  }

  // Turns a Polar subscription (webhook data) into user.billing and user.plan.
  function apply(user, sub) {
    const m = planFromProduct(sub.product);
    const status = normStatus(sub);
    const endsAt = sub.ends_at || (sub.cancel_at_period_end ? sub.current_period_end : null) || sub.ended_at || null;
    const endsMs = endsAt ? Date.parse(endsAt) : null;
    const stillPaid = ACTIVE.includes(status) || (status === 'cancelled' && endsMs && endsMs > Date.now());
    user.billing = {
      provider: 'polar',
      providerUpdatedAt: sub.modified_at || sub.created_at || null,
      subscriptionId: String(sub.id),
      customerId: String(sub.customer_id || (sub.customer && sub.customer.id) || ''),
      status,
      plan: m ? m.plan : '',
      interval: m ? m.interval : '',
      renewsAt: ACTIVE.includes(status) ? sub.current_period_end || null : null,
      endsAt,
      portalUrl: '',
      updatedAt: Date.now()
    };
    user.plan = stillPaid && m ? m.plan : 'free';
    return user;
  }

  // Webhook: verifies the signature, finds the user and applies the subscription.
  // deps: { getUser, saveUser, enforce } so this stays testable. Ignored events answer 202 so Polar does not retry.
  async function handleWebhook(raw, headers, deps) {
    if (!verify(raw, headers)) return { status: 401, body: { error: 'bad signature' } };
    let evt;
    try { evt = JSON.parse(raw); } catch (e) { return { status: 400, body: { error: 'bad json' } }; }
    const type = String((evt && evt.type) || '');
    const data = evt && evt.data;
    if (!type.startsWith('subscription.') || !data || !data.id) return { status: 202, body: { ignored: type || 'unknown' } };
    if (!planFromProduct(data.product)) return { status: 202, body: { ignored: 'not a Flowdeck product' } };

    let userId = null;
    const meta = data.metadata || {};
    if (meta.user_id && meta.sig === sign(String(meta.user_id))) userId = String(meta.user_id);
    if (!userId) { const m = await kv.getJSON('polarsub:' + data.id); userId = m && m.userId; }
    if (!userId) return { status: 202, body: { ignored: 'no user' } };

    const user = await deps.getUser(userId);
    if (!user) return { status: 202, body: { ignored: 'user gone' } };
    if (isSandbox() && !isTester(user)) return { status: 202, body: { ignored: 'test mode' } };
    const b = user.billing || {};
    const incomingStatus = normStatus(data);
    // Only one subscription drives the plan: ignore events for an older one once a newer one is active
    if (b.subscriptionId && b.subscriptionId !== String(data.id) && ACTIVE.includes(b.status) && !ACTIVE.includes(incomingStatus)) {
      return { status: 202, body: { ignored: 'other subscription active' } };
    }
    // Webhooks can arrive late or out of order: never let an older state overwrite a newer one
    const incoming = Date.parse(data.modified_at || data.created_at || '') || 0;
    const stored = Date.parse(b.providerUpdatedAt || '') || 0;
    if (b.subscriptionId === String(data.id) && incoming && stored && incoming < stored) return { status: 202, body: { ignored: 'stale event' } };

    await kv.setJSON('polarsub:' + data.id, { userId });
    apply(user, data);
    await deps.saveUser(user);
    if (deps.enforce) await deps.enforce(user);
    return { status: 200, body: { ok: true, plan: user.plan } };
  }

  // Cancels at the end of the paid period (used when the account is deleted).
  async function cancelSubscription(user) {
    try {
      await api('PATCH', '/v1/subscriptions/' + encodeURIComponent(user.billing.subscriptionId), { cancel_at_period_end: true });
    } catch (e) {
      if (e.status === 404) return true; // already gone at Polar
      if (e.status === 403 && /AlreadyCanceled|Inactive/i.test(e.code)) return true; // already cancelled or ended
      throw e;
    }
    return true;
  }

  // Signed-in customer portal link (a short-lived customer session); the public portal if that fails.
  async function portalUrl(user, appUrl) {
    const b = user.billing || {};
    if (!b.subscriptionId) return '';
    if (b.customerId) {
      try {
        const body = { customer_id: b.customerId };
        if (appUrl) body.return_url = appUrl + '/app/settings#plan';
        const d = await api('POST', '/v1/customer-sessions/', body);
        if (d.customer_portal_url) return d.customer_portal_url;
      } catch (e) { console.error('[billing] polar portal', e.message); }
    }
    return cfg().portal;
  }

  return { name: 'Polar', enabled, mode, planFromProduct, checkoutUrl, verify, apply, handleWebhook, cancelSubscription, portalUrl, _reset: () => { productCache = null; } };
};
module.exports.normStatus = normStatus;
