// Billing webhook for both providers. Uses the Web Request handler so the raw body is available for the signature check.
// Polar signs with Standard Webhooks headers (webhook-id, webhook-timestamp, webhook-signature); Lemon Squeezy with X-Signature.
import billing from './_lib/billing.js';
import store from './_lib/store.js';

export async function POST(request) {
  const raw = await request.text();
  const deps = {
    getUser: store.getUser,
    saveUser: store.saveUser,
    enforce: (user) => store.enforceLimit(user, store.limitFor(user))
  };
  try {
    const r = request.headers.get('webhook-signature')
      ? await billing.handlePolarWebhook(raw, request.headers, deps)
      : await billing.handleWebhook(raw, request.headers.get('x-signature'), deps);
    return Response.json(r.body, { status: r.status });
  } catch (e) {
    console.error('[billing webhook]', e && e.stack);
    return Response.json({ error: 'failed' }, { status: 500 });
  }
}

export function GET() {
  return Response.json({ ok: true, endpoint: 'billing webhook (Polar, Lemon Squeezy)' });
}
