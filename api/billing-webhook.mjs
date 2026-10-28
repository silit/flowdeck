// Lemon Squeezy webhook. Uses the Web Request handler so the raw body is available for the signature check.
import billing from './_lib/billing.js';
import store from './_lib/store.js';

export async function POST(request) {
  const raw = await request.text();
  try {
    const r = await billing.handleWebhook(raw, request.headers.get('x-signature'), {
      getUser: store.getUser,
      saveUser: store.saveUser,
      enforce: (user) => store.enforceLimit(user, store.limitFor(user))
    });
    return Response.json(r.body, { status: r.status });
  } catch (e) {
    console.error('[billing webhook]', e && e.stack);
    return Response.json({ error: 'failed' }, { status: 500 });
  }
}

export function GET() {
  return Response.json({ ok: true, endpoint: 'lemonsqueezy webhook' });
}
