'use strict';
// Paid plans through Lemon Squeezy (merchant of record).
// Env: LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID, LEMONSQUEEZY_WEBHOOK_SECRET
// Products/variants in the store are matched by name: "<product> <variant>" must contain
// the plan name (Solo, Studio, Agency) and "year" or "annual" for yearly variants.
const crypto = require('crypto');
const kv = require('./kv');

const PLANS = {
  solo: { name: 'Solo', sites: 5, monthly: 9, yearly: 90 },
  studio: { name: 'Studio', sites: 15, monthly: 24, yearly: 240 },
  agency: { name: 'Agency', sites: 40, monthly: 49, yearly: 490 }
};
const ACTIVE = ['active', 'on_trial', 'past_due'];

function cfg() {
  return {
    key: String(process.env.LEMONSQUEEZY_API_KEY || '').trim(),
    store: String(process.env.LEMONSQUEEZY_STORE_ID || '').replace(/\D/g, ''), // tolerate "#123"
    secret: String(process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '').trim(),
    base: (process.env.LEMONSQUEEZY_API_BASE || 'https://api.lemonsqueezy.com').replace(/\/+$/, '')
  };
}
function enabled() { const c = cfg(); return !!(c.key && c.store); }

async function api(method, path, body) {
  const c = cfg();
  const res = await fetch(c.base + path, {
    method,
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', Authorization: 'Bearer ' + c.key },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data && data.errors && data.errors[0] ? (data.errors[0].detail || data.errors[0].title) : res.status;
    throw Object.assign(new Error('Lemon Squeezy: ' + msg), { status: res.status });
  }
  return data;
}

function planFromNames(productName, variantName) {
  const s = (String(productName || '') + ' ' + String(variantName || '')).toLowerCase();
  const plan = Object.keys(PLANS).find((k) => s.includes(k));
  if (!plan) return null;
  return { plan, interval: /year|annual/.test(s) ? 'yearly' : 'monthly' };
}

let variantCache = null;
async function variants() {
  if (variantCache && variantCache.at > Date.now() - 3600000) return variantCache.map;
  const c = cfg();
  const products = await api('GET', `/v1/products?filter[store_id]=${encodeURIComponent(c.store)}&page[size]=50`);
  const map = {};
  const seen = [];
  for (const p of products.data || []) {
    const vs = await api('GET', `/v1/variants?filter[product_id]=${encodeURIComponent(p.id)}&page[size]=50`);
    for (const v of vs.data || []) {
      const a = v.attributes || {};
      seen.push(`${p.attributes.name} / ${a.name} (${a.status}${a.test_mode ? ', test' : ''})`);
      if (a.status === 'pending') continue;
      const m = planFromNames(p.attributes.name, a.name);
      if (m && (!map[m.plan + ':' + m.interval] || a.status === 'published')) {
        map[m.plan + ':' + m.interval] = v.id;
        map._test = !!a.test_mode;
      }
    }
  }
  map._seen = `${(products.data || []).length} product(s) in store ${c.store}: ${seen.join('; ') || 'no variants'}`;
  // Only cache a usable result, so a fix in the store shows up right away
  if (Object.keys(map).length > 1) variantCache = { at: Date.now(), map };
  return map;
}

// While the store only has test-mode variants (store not yet activated by Lemon Squeezy), a checkout
// would accept the public test card, so it is open only to the emails in BILLING_TEST_EMAILS.
function isTester(user) {
  const list = String(process.env.BILLING_TEST_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length || !user) return false;
  // Only the account email, which comes from Webflow. The alert email is user-editable and unverified.
  return list.includes(String(user.email || '').trim().toLowerCase());
}

// 'live' when real plans can be sold, 'test' when only test-mode variants exist, 'off' otherwise.
async function mode() {
  if (!enabled()) return 'off';
  try {
    const map = await Promise.race([variants(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 4000))]);
    if (!Object.keys(map).some((k) => !k.startsWith('_'))) return 'off';
    return map._test ? 'test' : 'live';
  } catch (e) {
    console.error('[billing] mode', e.message);
    return 'off';
  }
}

async function canCheckout(user) {
  const m = await mode();
  return m === 'live' || (m === 'test' && isTester(user));
}

function sign(userId) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'flowdeck').update('billing:' + userId).digest('hex').slice(0, 24);
}

async function checkoutUrl(user, plan, interval, appUrl) {
  if (!PLANS[plan]) throw new Error('Unknown plan');
  interval = interval === 'yearly' ? 'yearly' : 'monthly';
  const map = await variants();
  const variantId = map[plan + ':' + interval];
  if (!variantId) throw new Error(`No ${PLANS[plan].name} ${interval} variant found. Lemon Squeezy returned ${map._seen}.`);
  if (map._test && !isTester(user)) throw new Error('Paid plans are not open yet.');
  const c = cfg();
  const data = await api('POST', '/v1/checkouts', {
    data: {
      type: 'checkouts',
      attributes: {
        test_mode: !!map._test,
        checkout_data: { email: user.settings.alertEmail || user.email || undefined, custom: { user_id: user.id, sig: sign(user.id) } },
        product_options: { redirect_url: appUrl + '/app/settings?upgraded=1', enabled_variants: [Number(variantId)] }
      },
      relationships: { store: { data: { type: 'stores', id: String(c.store) } }, variant: { data: { type: 'variants', id: String(variantId) } } }
    }
  });
  return data.data.attributes.url;
}

function verify(raw, signature) {
  const secret = cfg().secret;
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Turns a subscription object (webhook data or API) into user.billing and user.plan.
function apply(user, sub) {
  const a = sub.attributes || {};
  const m = planFromNames(a.product_name, a.variant_name);
  const endsAt = a.ends_at ? Date.parse(a.ends_at) : null;
  const stillPaid = ACTIVE.includes(a.status) || (a.status === 'cancelled' && endsAt && endsAt > Date.now());
  user.billing = {
    lsUpdatedAt: a.updated_at || null,
    subscriptionId: String(sub.id),
    status: a.status || '',
    plan: m ? m.plan : '',
    interval: m ? m.interval : '',
    renewsAt: a.renews_at || null,
    endsAt: a.ends_at || null,
    portalUrl: (a.urls && a.urls.customer_portal) || '',
    updatedAt: Date.now()
  };
  user.plan = stillPaid && m ? m.plan : 'free';
  return user;
}

// Webhook: verifies the signature, finds the user and applies the subscription.
// deps: { getUser, saveUser, enforce } so this stays testable.
async function handleWebhook(raw, signature, deps) {
  if (!verify(raw, signature)) return { status: 401, body: { error: 'bad signature' } };
  let evt;
  try { evt = JSON.parse(raw); } catch (e) { return { status: 400, body: { error: 'bad json' } }; }
  const name = evt.meta && evt.meta.event_name;
  const data = evt.data;
  if (!name || !String(name).startsWith('subscription_') || !data || data.type !== 'subscriptions') return { status: 200, body: { ignored: name || 'unknown' } };

  let userId = null;
  const custom = (evt.meta && evt.meta.custom_data) || {};
  if (custom.user_id && custom.sig === sign(custom.user_id)) userId = String(custom.user_id);
  if (!userId) { const m = await kv.getJSON('lssub:' + data.id); userId = m && m.userId; }
  if (!userId) return { status: 200, body: { ignored: 'no user' } };

  const user = await deps.getUser(userId);
  if (!user) return { status: 200, body: { ignored: 'user gone' } };
  // Test-mode payments never change a real user's plan
  const testEvent = !!((evt.meta && evt.meta.test_mode) || (data.attributes && data.attributes.test_mode));
  if (testEvent && !isTester(user)) return { status: 200, body: { ignored: 'test mode' } };
  // Only one subscription drives the plan: ignore events for an older one once a newer one exists
  if (user.billing && user.billing.subscriptionId && user.billing.subscriptionId !== String(data.id) && ACTIVE.includes(user.billing.status) && !ACTIVE.includes((data.attributes || {}).status)) {
    return { status: 200, body: { ignored: 'other subscription active' } };
  }
  // Webhooks can arrive late or out of order: never let an older event overwrite a newer one
  const b = user.billing || {};
  const incoming = Date.parse((data.attributes || {}).updated_at || '') || 0;
  const stored = Date.parse(b.lsUpdatedAt || '') || 0;
  if (b.subscriptionId === String(data.id) && incoming && stored && incoming < stored) return { status: 200, body: { ignored: 'stale event' } };
  await kv.setJSON('lssub:' + data.id, { userId });
  apply(user, data);
  await deps.saveUser(user);
  if (deps.enforce) await deps.enforce(user);
  return { status: 200, body: { ok: true, plan: user.plan } };
}

// True while the user still has a subscription that will charge or is paid up.
function hasLiveSubscription(user) {
  const b = user && user.billing;
  if (!b || !b.subscriptionId) return false;
  if (ACTIVE.includes(b.status)) return true;
  return false;
}

// Cancels the subscription at Lemon Squeezy (it stays active until the end of the paid period).
async function cancelSubscription(user) {
  if (!hasLiveSubscription(user)) return true;
  try {
    await api('DELETE', '/v1/subscriptions/' + encodeURIComponent(user.billing.subscriptionId));
  } catch (e) {
    if (e.status === 404) return true; // already gone at Lemon Squeezy
    throw e;
  }
  return true;
}

// Fresh customer portal link (signed links expire after 24 hours).
async function portalUrl(user) {
  if (!user.billing || !user.billing.subscriptionId) return '';
  try {
    const d = await api('GET', '/v1/subscriptions/' + encodeURIComponent(user.billing.subscriptionId));
    return (d.data && d.data.attributes && d.data.attributes.urls && d.data.attributes.urls.customer_portal) || user.billing.portalUrl || '';
  } catch (e) { return user.billing.portalUrl || ''; }
}

module.exports = { PLANS, enabled, mode, canCheckout, isTester, hasLiveSubscription, cancelSubscription, planFromNames, checkoutUrl, verify, apply, handleWebhook, portalUrl, sign, _reset: () => { variantCache = null; } };
