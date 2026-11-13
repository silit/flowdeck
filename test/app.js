// End-to-end test: mock Webflow API, mock Upstash Redis, mock Resend, two mock customer sites.
// Run: node test/app.js
const http = require('http');
const crypto = require('crypto');

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log('  ok   ' + m); } else { failed++; console.log('  FAIL ' + m); } }
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function readJSON(req) { return new Promise((resolve) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { const raw = Buffer.concat(ch).toString(); try { resolve(raw ? JSON.parse(raw) : null); } catch (e) { resolve(null); } }); }); }
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

/* ---- mock Redis (Upstash REST subset) ---- */
const db = new Map();
const ttl = new Map();
function alive(k) { if (ttl.has(k) && ttl.get(k) < Date.now()) { db.delete(k); ttl.delete(k); } return db.has(k); }
function exec(cmd) {
  const [c, ...a] = cmd;
  switch (c.toUpperCase()) {
    case 'GET': return alive(a[0]) ? db.get(a[0]) : null;
    case 'GETDEL': { const v = alive(a[0]) ? db.get(a[0]) : null; db.delete(a[0]); ttl.delete(a[0]); return v; }
    case 'MGET': return a.map((k) => (alive(k) ? db.get(k) : null));
    case 'SET': {
      const nx = a.includes('NX'); const xx = a.includes('XX'); const exI = a.indexOf('EX');
      if (nx && alive(a[0])) return null;
      if (xx && !alive(a[0])) return null;
      db.set(a[0], a[1]);
      if (exI > -1) ttl.set(a[0], Date.now() + parseInt(a[exI + 1], 10) * 1000); else ttl.delete(a[0]);
      return 'OK';
    }
    case 'DEL': { let n = 0; for (const k of a) if (db.delete(k)) n++; return n; }
    case 'SADD': { const s = alive(a[0]) ? db.get(a[0]) : new Set(); let n = 0; for (const m of a.slice(1)) if (!s.has(m)) { s.add(m); n++; } db.set(a[0], s); return n; }
    case 'SREM': { const s = alive(a[0]) ? db.get(a[0]) : new Set(); let n = 0; for (const m of a.slice(1)) if (s.delete(m)) n++; return n; }
    case 'SMEMBERS': return alive(a[0]) ? [...db.get(a[0])] : [];
    case 'LPUSH': { const l = alive(a[0]) ? db.get(a[0]) : []; l.unshift(...a.slice(1).reverse()); db.set(a[0], l); return l.length; }
    case 'LTRIM': { const l = alive(a[0]) ? db.get(a[0]) : []; db.set(a[0], l.slice(parseInt(a[1], 10), parseInt(a[2], 10) + 1)); return 'OK'; }
    case 'LRANGE': { const l = alive(a[0]) ? db.get(a[0]) : []; const end = parseInt(a[2], 10); return l.slice(parseInt(a[1], 10), end === -1 ? undefined : end + 1); }
    case 'INCR': { const v = (alive(a[0]) ? parseInt(db.get(a[0]), 10) : 0) + 1; db.set(a[0], String(v)); return v; }
    case 'EXPIRE': ttl.set(a[0], Date.now() + parseInt(a[1], 10) * 1000); return 1;
    default: throw new Error('mock redis: unsupported ' + c);
  }
}
let redisCalls = 0; // commands received, to prove which requests never reach the database
const redis = http.createServer(async (req, res) => {
  const body = await readJSON(req);
  const u = new URL(req.url, 'http://x');
  redisCalls += u.pathname === '/pipeline' && Array.isArray(body) ? body.length : 1;
  if (u.pathname === '/pipeline') return json(res, 200, body.map((cmd) => { try { return { result: exec(cmd) }; } catch (e) { return { error: e.message }; } }));
  try { json(res, 200, { result: exec(body) }); } catch (e) { json(res, 400, { error: e.message }); }
});

/* ---- mock customer sites ---- */
let siteBStatus = 200;
const siteA = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>A</body></html>'); });
const siteB = http.createServer((req, res) => { res.writeHead(siteBStatus, { 'Content-Type': 'text/html' }); res.end('<html><body>B</body></html>'); });

/* ---- mock Resend ---- */
const emails = [];
let resendFail = false;
const resend = http.createServer(async (req, res) => { const body = await readJSON(req); if (resendFail) return json(res, resendFail === true ? 500 : resendFail, { message: resendFail === true ? 'resend down' : 'refused' }); emails.push(body); json(res, 200, { id: 'em_' + emails.length }); });

/* ---- mock Webflow ---- */
const DAY = 86400000;
const now = Date.now();
function iso(ms) { return new Date(ms).toISOString(); }
const wfState = { sites: [], submissions: {}, pages: {}, collections: {}, counts: {}, revoked: false, revokeCalls: [] };
const webflow = http.createServer(async (req, res) => {
  const body = await readJSON(req);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/oauth/access_token') {
    wfState.tokenCalls = (wfState.tokenCalls || 0) + 1;
    if (!['good-code', 'install-code'].includes(body.code) || body.client_id !== 'cid' || body.client_secret !== 'sec') return json(res, 400, { error: 'invalid_grant' });
    // like Webflow: redirect_uri must be sent exactly when the authorization link had one
    // (good-code comes from our /auth link with redirect_uri, install-code from the Marketplace link without it)
    if (body.code === 'good-code' && body.redirect_uri !== 'https://app.test/callback') return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    if (body.code === 'install-code' && body.redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
    return json(res, 200, { access_token: 'tok_abc', token_type: 'bearer' });
  }
  if (u.pathname === '/oauth/revoke_authorization') { wfState.revokeCalls.push(body); return json(res, 200, { didRevoke: true }); }
  if (wfState.revoked || (req.headers.authorization || '') !== 'Bearer tok_abc') return json(res, 401, { message: 'Request not authorized' });
  if ((wfState.refusedSites || []).some((id) => u.pathname.includes('/' + id))) return json(res, 401, { message: 'Request not authorized' });
  const p = u.pathname;
  let m;
  if (p === '/v2/token/authorized_by') return json(res, 200, { id: 'user_1', email: 'owner@agency.com', firstName: 'Ada', lastName: 'Lovelace' });
  if (p === '/v2/sites') return json(res, 200, { sites: wfState.sites });
  if ((m = p.match(/^\/v2\/sites\/(\w+)$/))) { const s = wfState.sites.find((x) => x.id === m[1]); return s ? json(res, 200, s) : json(res, 404, { message: 'nope' }); }
  if ((m = p.match(/^\/v2\/sites\/(\w+)\/pages$/))) { const all = wfState.pages[m[1]] || []; const off = parseInt(u.searchParams.get('offset') || '0', 10); return json(res, 200, { pages: all.slice(off, off + 100), pagination: { limit: 100, offset: off, total: all.length } }); }
  if ((m = p.match(/^\/v2\/sites\/(\w+)\/form_submissions$/))) { const all = wfState.submissions[m[1]] || []; const off = parseInt(u.searchParams.get('offset') || '0', 10); return json(res, 200, { formSubmissions: all.slice(off, off + 100), pagination: { limit: 100, offset: off, total: all.length } }); }
  if ((m = p.match(/^\/v2\/sites\/(\w+)\/collections$/))) return json(res, 200, { collections: wfState.collections[m[1]] || [] });
  if ((m = p.match(/^\/v2\/collections\/(\w+)\/items$/))) return json(res, 200, { items: [], pagination: { limit: 1, offset: 0, total: wfState.counts[m[1]] || 0 } });
  json(res, 404, { message: 'mock: no route ' + p });
});

/* ---- app under test ---- */
function startApp() {
  const handler = require('../api/index.js');
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    req.query = Object.fromEntries(u.searchParams);
    req.query.path = u.pathname.replace(/^\//, '');
    handler(req, res);
  });
}
function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(ch).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const form = (obj) => new URLSearchParams(obj).toString();
const cookiesFrom = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

(async () => {
  const redisPort = await listen(redis);
  const aPort = await listen(siteA);
  const bPort = await listen(siteB);
  const resendPort = await listen(resend);
  const wfPort = await listen(webflow);

  Object.assign(process.env, {
    WEBFLOW_CLIENT_ID: 'cid', WEBFLOW_CLIENT_SECRET: 'sec', SESSION_SECRET: 'test-session-secret-which-is-long',
    APP_URL: 'https://app.test', CRON_SECRET: 'cronkey', FREE_SITE_LIMIT: '2', SITE_URL_SCHEME: 'http', ALLOW_PRIVATE_CHECKS: '1', REVOKE_CONFIRM_MS: '0',
    KV_REST_API_URL: 'http://127.0.0.1:' + redisPort, KV_REST_API_TOKEN: 't',
    WEBFLOW_API_BASE: 'http://127.0.0.1:' + wfPort, WEBFLOW_AUTH_BASE: 'http://127.0.0.1:' + wfPort,
    RESEND_API_KEY: 'rk', RESEND_API_BASE: 'http://127.0.0.1:' + resendPort, EMAIL_FROM: 'Flowdeck <t@test>'
  });

  wfState.sites = [
    { id: 'siteA', workspaceId: 'ws1', displayName: 'Acme Dental', shortName: 'acme-dental', customDomains: [{ id: 'd1', url: '127.0.0.1:' + aPort }], lastPublished: iso(now - 2 * DAY), lastUpdated: iso(now - 3 * DAY), previewUrl: 'https://acme.design.webflow.com' },
    { id: 'siteB', workspaceId: 'ws1', displayName: 'Blue Yachts', shortName: 'blue-yachts', customDomains: [{ id: 'd2', url: '127.0.0.1:' + bPort }], lastPublished: iso(now - 20 * DAY), lastUpdated: iso(now - 1 * DAY) },
    { id: 'siteC', workspaceId: 'ws2', displayName: 'Third Site', shortName: 'third-site', customDomains: [], lastPublished: iso(now - DAY), lastUpdated: iso(now - DAY) }
  ];
  wfState.pages.siteA = [
    { id: 'p1', title: 'Home', slug: 'home', publishedPath: '/', seo: { title: 'Acme Dental', description: 'Great smiles' } },
    { id: 'p2', title: 'About', slug: 'about', publishedPath: '/about', seo: { title: '', description: '' } },
    { id: 'p3', title: 'Contact', slug: 'contact', publishedPath: '/contact', seo: { title: 'Acme Dental', description: 'x'.repeat(170) } },
    { id: 'p4', title: 'Old', slug: 'old', archived: true, seo: { title: '', description: '' } }
  ];
  wfState.pages.siteB = [{ id: 'p5', title: 'Home', slug: 'home', publishedPath: '/', seo: { title: 'Blue Yachts', description: 'Charter' } }];
  wfState.submissions.siteA = [
    { id: 's1', displayName: 'Contact Form', dateSubmitted: iso(now - 1 * DAY), formResponse: {} },
    { id: 's2', displayName: 'Contact Form', dateSubmitted: iso(now - 5 * DAY), formResponse: {} },
    { id: 's3', displayName: 'Quote', dateSubmitted: iso(now - 20 * DAY), formResponse: {} },
    { id: 's4', displayName: 'Quote', dateSubmitted: iso(now - 45 * DAY), formResponse: {} }
  ];
  wfState.submissions.siteB = [];
  wfState.collections.siteA = [{ id: 'c1', displayName: 'Blog' }, { id: 'c2', displayName: 'Treatments' }];
  wfState.counts = { c1: 1900, c2: 40 };

  const app = startApp();
  const port = await listen(app);

  console.log('1. sign in with Webflow creates the user, stores sites, applies the plan limit');
  const auth = await request(port, 'GET', '/auth');
  const loc = new URL(auth.headers.location);
  assert(auth.status === 302 && loc.searchParams.get('scope') === 'authorized_user:read sites:read pages:read cms:read forms:read', 'authorize url with read-only scopes');
  const state = loc.searchParams.get('state');
  const cb = await request(port, 'GET', '/callback?code=good-code&state=' + state, { headers: { Cookie: cookiesFrom(auth) } });
  assert(cb.status === 302 && cb.headers.location === '/app?added=3', 'callback redirects to the dashboard with 3 sites added');
  const session = cookiesFrom(cb);
  assert(/fd_session=/.test(session), 'session cookie set');
  const userRaw = JSON.parse(db.get('user:user_1'));
  assert(userRaw.email === 'owner@agency.com' && userRaw.connections.length === 1 && !JSON.stringify(userRaw).includes('tok_abc'), 'user stored with an encrypted token');
  const sA = JSON.parse(db.get('site:siteA')), sB = JSON.parse(db.get('site:siteB')), sC = JSON.parse(db.get('site:siteC'));
  assert(sA.monitored && sB.monitored && !sC.monitored, 'third site paused by the free limit of 2');
  assert(sA.data && sA.data.pages.issues === 4 && sA.data.pages.missingTitle.length === 1 && sA.data.pages.missingDesc.length === 1 && sA.data.pages.longDesc.length === 1 && sA.data.pages.dupTitle.length === 1, 'SEO analysis: missing title and description, long description, duplicate title; archived page ignored');
  assert(sA.data.forms.total7 === 2 && sA.data.forms.total30 === 3, 'form counts for 7 and 30 days');
  assert(sA.data.cms.total === 1940, 'CMS item total');
  assert(sA.status.up === true, 'initial check marks site A up');

  console.log('2. dashboard');
  const anon = await request(port, 'GET', '/app');
  assert(anon.status === 302 && anon.headers.location === '/login', 'anonymous dashboard goes to the email sign in page, not to Webflow OAuth');
  const dash = await request(port, 'GET', '/app', { headers: { Cookie: session } });
  assert(dash.status === 200 && dash.body.includes('Acme Dental') && dash.body.includes('Blue Yachts') && dash.body.includes('Paused'), 'dashboard lists sites and the paused one');
  assert(dash.body.includes('<td class="num">2 <span class="muted">/ 3</span></td>'), 'dashboard shows form counts');

  console.log('3. cron checks: down after two failures, alert email once, recovery email');
  const noKey = await request(port, 'GET', '/cron/checks');
  assert(noKey.status === 401, 'cron without key is rejected');
  siteBStatus = 503;
  let r = await request(port, 'GET', '/cron/checks?key=cronkey');
  let out = JSON.parse(r.body);
  assert(r.status === 200 && out.checked === 2, 'two monitored sites checked');
  let b = JSON.parse(db.get('site:siteB'));
  const downMails = () => emails.filter((e) => e.subject.includes('is down'));
  assert(b.status.fails === 1 && b.status.up !== false && downMails().length === 0, 'one failure: not down yet, no down email');
  r = await request(port, 'GET', '/cron/checks?key=cronkey');
  b = JSON.parse(db.get('site:siteB'));
  assert(b.status.up === false && b.status.fails === 2, 'second failure marks the site down');
  assert(downMails().length === 1 && downMails()[0].subject.includes('Blue Yachts is down') && downMails()[0].to[0] === 'owner@agency.com', 'down alert emailed once');
  r = await request(port, 'GET', '/cron/checks?key=cronkey');
  assert(downMails().length === 1, 'still down: no repeat email');
  siteBStatus = 200;
  r = await request(port, 'GET', '/cron/checks?key=cronkey');
  b = JSON.parse(db.get('site:siteB'));
  const upMails = emails.filter((e) => e.subject.includes('back up'));
  assert(b.status.up === true && upMails.length === 1, 'recovery marks up and emails once');
  assert(!emails.some((e) => e.subject.includes('unpublished changes')), 'the checks job leaves the unpublished rule to the sync job');
  const checksA = JSON.parse(db.get('site:siteA'));
  assert((db.get('uptime:siteA') || []).length === 5, 'uptime history stored (1 initial + 4 cron)');

  console.log('4. site detail, settings, client report');
  const detail = await request(port, 'GET', '/app/site?id=siteA', { headers: { Cookie: session } });
  assert(detail.status === 200 && detail.body.includes('Missing meta title') && detail.body.includes('Contact Form') && detail.body.includes('1,940'.replace(',', '')), 'detail page shows SEO issues, forms and CMS');
  const save = await request(port, 'POST', '/app/site/settings', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form({ id: 'siteA', client: 'Acme Dental Clinic', plan: 'cms', checkUrl: '', alerts: '1' }) });
  assert(save.status === 302 && JSON.parse(db.get('site:siteA')).settings.plan === 'cms', 'settings saved');
  const dash2 = await request(port, 'GET', '/app', { headers: { Cookie: session } });
  assert(dash2.body.includes('1940 / 2000 (97%)'), 'CMS usage against the plan limit shows a warning');
  const foreign = await request(port, 'POST', '/app/site/settings', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.test' }, body: form({ id: 'siteA', client: 'x' }) });
  assert(foreign.status === 403, 'cross-origin POST blocked');
  const rep = await request(port, 'POST', '/app/site/report', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form({ id: 'siteA', action: 'create' }) });
  const tok = JSON.parse(db.get('site:siteA')).settings.reportToken;
  assert(rep.status === 302 && tok, 'report token created');
  const pub = await request(port, 'GET', '/r/' + tok);
  assert(pub.status === 200 && pub.body.includes('Acme Dental Clinic') && !pub.body.includes('Sign out') && pub.headers['x-robots-tag'] === 'noindex', 'public report renders without a session and is noindex');
  await request(port, 'POST', '/app/site/report', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form({ id: 'siteA', action: 'rotate' }) });
  const old = await request(port, 'GET', '/r/' + tok);
  assert(old.status === 404, 'rotated report link stops working');

  console.log('5. sync job and weekly digest');
  wfState.submissions.siteA = []; // forms go silent
  r = await request(port, 'GET', '/cron/sync?key=cronkey');
  out = JSON.parse(r.body);
  assert(r.status === 200 && out.synced === 2, 'sync job refreshed both monitored sites');
  const a2 = JSON.parse(db.get('site:siteA'));
  assert(a2.data.forms.total30 === 0 && a2.data.forms.before30 === 3, 'baseline kept for the silent-form rule');
  assert(emails.some((e) => e.subject.includes('No form submissions')), 'silent form alert fired');
  const unpub = emails.find((e) => e.subject.includes('unpublished changes'));
  assert(unpub && unpub.subject.includes('Blue Yachts'), 'unpublished-for-7-days alert fired for site B');
  r = await request(port, 'GET', '/cron/digest?key=cronkey&force=1');
  out = JSON.parse(r.body);
  assert(out.sent === 1 && emails[emails.length - 1].subject.includes('Weekly report') && emails[emails.length - 1].html.includes('Acme Dental Clinic'), 'weekly digest sent with the site table');
  const weekly = () => emails.filter((e) => e.subject.includes('Weekly report')).length;
  const weeklyBefore = weekly();
  r = await request(port, 'GET', '/cron/digest?key=cronkey&force=1');
  assert(JSON.parse(r.body).sent === 0 && weekly() === weeklyBefore, 'digest not sent twice on the same day');

  console.log('6. plans and billing (Lemon Squeezy)');
  const lsCalls = [];
  let lsTest = false;
  const ls = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readJSON(req) : null;
    lsCalls.push({ method: req.method, path: u.pathname, search: u.search, body, auth: req.headers.authorization });
    if (u.pathname === '/v1/products') return json(res, 200, { data: [{ id: 'p1', attributes: { name: 'Flowdeck' } }] });
    if (u.pathname === '/v1/variants') return json(res, 200, { data: [
      { id: '11', attributes: { name: 'Solo Monthly', status: 'published', test_mode: lsTest } }, { id: '12', attributes: { name: 'Solo Yearly', status: 'published', test_mode: lsTest } },
      { id: '21', attributes: { name: 'Studio Monthly', status: 'published', test_mode: lsTest } }, { id: '22', attributes: { name: 'Studio Yearly', status: 'published', test_mode: lsTest } },
      { id: '31', attributes: { name: 'Agency Monthly', status: 'published', test_mode: lsTest } }, { id: '32', attributes: { name: 'Agency Yearly', status: 'published', test_mode: lsTest } }] });
    if (u.pathname === '/v1/checkouts') return json(res, 201, { data: { id: 'chk1', attributes: { url: 'https://silit.lemonsqueezy.com/checkout/custom/abc' } } });
    if (req.method === 'DELETE' && u.pathname === '/v1/subscriptions/gone') return json(res, 404, { errors: [{ detail: 'not found' }] });
    if (req.method === 'DELETE' && u.pathname === '/v1/subscriptions/broken') return json(res, 500, { errors: [{ detail: 'server error' }] });
    if (req.method === 'DELETE' && u.pathname.startsWith('/v1/subscriptions/')) return json(res, 200, { data: { id: u.pathname.split('/').pop(), attributes: { status: 'cancelled' } } });
    if (u.pathname === '/v1/subscriptions/900') return json(res, 200, { data: { id: '900', attributes: { urls: { customer_portal: 'https://silit.lemonsqueezy.com/billing?fresh=1' } } } });
    json(res, 404, {});
  });
  const lsPort = await listen(ls);
  Object.assign(process.env, { LEMONSQUEEZY_API_KEY: 'lskey', LEMONSQUEEZY_STORE_ID: '77', LEMONSQUEEZY_WEBHOOK_SECRET: 'whsec', LEMONSQUEEZY_API_BASE: 'http://127.0.0.1:' + lsPort });
  const post = (p, data) => request(port, 'POST', p, { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form(data) });
  const setPage = await request(port, 'GET', '/app/settings', { headers: { Cookie: session } });
  assert(setPage.body.includes('Studio</strong> · 15 sites') && setPage.body.includes('$24/mo') && setPage.body.includes('$240/yr'), 'settings lists paid plans with checkout buttons');
  const co = await post('/app/billing/checkout', { plan: 'studio', interval: 'yearly' });
  const coCall = lsCalls.find((c) => c.path === '/v1/checkouts');
  assert(co.status === 302 && co.headers.location === 'https://silit.lemonsqueezy.com/checkout/custom/abc', 'checkout redirects to Lemon Squeezy');
  assert(coCall && coCall.auth === 'Bearer lskey' && coCall.body.data.relationships.variant.data.id === '22' && coCall.body.data.relationships.store.data.id === '77' && coCall.body.data.attributes.checkout_data.custom.user_id === 'user_1', 'checkout uses the Studio Yearly variant and carries the user id');
  const sig = coCall.body.data.attributes.checkout_data.custom.sig;
  const hook = await import('../api/billing-webhook.mjs');
  const sendHook = async (evt, secret) => {
    const raw = JSON.stringify(evt);
    const h = crypto.createHmac('sha256', secret || 'whsec').update(raw).digest('hex');
    const r = await hook.POST(new Request('https://app.test/billing/webhook', { method: 'POST', headers: { 'x-signature': h, 'content-type': 'application/json' }, body: raw }));
    return { status: r.status, body: await r.json() };
  };
  const sub = (status, variant, extra) => ({ type: 'subscriptions', id: '900', attributes: Object.assign({ status, product_name: 'Flowdeck', variant_name: variant, renews_at: iso(now + 365 * DAY), ends_at: null, urls: { customer_portal: 'https://silit.lemonsqueezy.com/billing?old=1' } }, extra || {}) });
  let wh = await sendHook({ meta: { event_name: 'subscription_created', custom_data: { user_id: 'user_1', sig } }, data: sub('active', 'Studio Yearly') }, 'wrong');
  assert(wh.status === 401, 'webhook with a bad signature is rejected');
  wh = await sendHook({ meta: { event_name: 'subscription_created', custom_data: { user_id: 'user_1', sig: 'forged' } }, data: Object.assign(sub('active', 'Agency Monthly'), { id: '901' }) });
  assert(wh.body.ignored === 'no user' && JSON.parse(db.get('user:user_1')).plan === 'free', 'webhook with a forged user id is ignored');
  wh = await sendHook({ meta: { event_name: 'subscription_created', custom_data: { user_id: 'user_1', sig } }, data: sub('active', 'Studio Yearly') });
  let u1 = JSON.parse(db.get('user:user_1'));
  assert(wh.status === 200 && u1.plan === 'studio' && u1.billing.interval === 'yearly' && u1.billing.subscriptionId === '900', 'subscription_created upgrades the user to Studio');
  assert(JSON.parse(db.get('site:siteC')).monitored, 'paused third site is monitored after the upgrade');
  const mon = await post('/app/site/monitor', { id: 'siteC', on: '0' });
  await request(port, 'GET', '/app', { headers: { Cookie: session } });
  const c3 = JSON.parse(db.get('site:siteC'));
  assert(mon.status === 302 && !c3.monitored && c3.pausedByUser, 'user can pause a site and it stays paused');
  const portal = await request(port, 'GET', '/app/billing/portal', { headers: { Cookie: session } });
  assert(portal.status === 302 && portal.headers.location === 'https://silit.lemonsqueezy.com/billing?fresh=1', 'billing portal link is fetched fresh');
  wh = await sendHook({ meta: { event_name: 'subscription_cancelled' }, data: sub('cancelled', 'Studio Yearly', { ends_at: iso(now + 30 * DAY) }) });
  assert(JSON.parse(db.get('user:user_1')).plan === 'studio', 'cancelled subscription keeps the plan until it ends');
  await post('/app/site/monitor', { id: 'siteC', on: '1' });
  wh = await sendHook({ meta: { event_name: 'subscription_expired' }, data: sub('expired', 'Studio Yearly', { ends_at: iso(now - DAY) }) });
  u1 = JSON.parse(db.get('user:user_1'));
  const monitoredNow = ['siteA', 'siteB', 'siteC'].filter((id) => JSON.parse(db.get('site:' + id)).monitored);
  assert(u1.plan === 'free' && monitoredNow.length === 2 && !monitoredNow.includes('siteC'), 'expired subscription drops to free and pauses the newest site');

  // Store still in test mode (not activated): no checkout for real users, test payments ignored
  lsTest = true;
  require('../api/_lib/billing')._reset();
  const testPage = await request(port, 'GET', '/app/settings', { headers: { Cookie: session } });
  assert(!testPage.body.includes('/app/billing/checkout') && testPage.body.includes('Paid plans are opening shortly'), 'test-mode store hides checkout buttons from users');
  const checkoutsBefore = lsCalls.filter((c) => c.path === '/v1/checkouts').length;
  const coTest = await post('/app/billing/checkout', { plan: 'agency', interval: 'monthly' });
  assert(coTest.status === 503 && lsCalls.filter((c) => c.path === '/v1/checkouts').length === checkoutsBefore, 'test-mode checkout is refused for users');
  wh = await sendHook({ meta: { event_name: 'subscription_created', test_mode: true, custom_data: { user_id: 'user_1', sig } }, data: Object.assign(sub('active', 'Agency Monthly', { test_mode: true }), { id: '902' }) });
  assert(wh.body.ignored === 'test mode' && JSON.parse(db.get('user:user_1')).plan === 'free', 'test-mode payment does not upgrade a real user');
  process.env.BILLING_TEST_EMAILS = 'tester@silitlabs.com';
  const billingMod = require('../api/_lib/billing');
  assert(!billingMod.isTester({ email: 'owner@agency.com', settings: { alertEmail: 'tester@silitlabs.com' } }) && billingMod.isTester({ email: 'Tester@silitlabs.com', settings: {} }), 'only the Webflow account email counts as a tester, not the editable alert email');
  process.env.BILLING_TEST_EMAILS = 'someone@else.com, OWNER@agency.com';
  const testerPage = await request(port, 'GET', '/app/settings', { headers: { Cookie: session } });
  assert(testerPage.body.includes('/app/billing/checkout'), 'tester sees checkout buttons in test mode');
  const coTester = await post('/app/billing/checkout', { plan: 'agency', interval: 'monthly' });
  const lastCo = lsCalls.filter((c) => c.path === '/v1/checkouts').pop();
  assert(coTester.status === 302 && lastCo.body.data.attributes.test_mode === true, 'tester gets a test-mode checkout');
  wh = await sendHook({ meta: { event_name: 'subscription_created', test_mode: true, custom_data: { user_id: 'user_1', sig } }, data: Object.assign(sub('active', 'Agency Monthly', { test_mode: true }), { id: '903' }) });
  assert(wh.body.ok && JSON.parse(db.get('user:user_1')).plan === 'agency', 'tester test payment upgrades the plan');
  wh = await sendHook({ meta: { event_name: 'subscription_updated', test_mode: true }, data: Object.assign(sub('active', 'Agency Monthly', { test_mode: true, updated_at: iso(now) }), { id: '903' }) });
  wh = await sendHook({ meta: { event_name: 'subscription_expired', test_mode: true }, data: Object.assign(sub('expired', 'Agency Monthly', { test_mode: true, ends_at: iso(now - DAY), updated_at: iso(now - 3600000) }), { id: '903' }) });
  assert(wh.body.ignored === 'stale event' && JSON.parse(db.get('user:user_1')).plan === 'agency', 'a late, older webhook does not overwrite a newer one');
  const lsBefore = lsCalls.length;
  await billingMod.cancelSubscription(JSON.parse(db.get('user:user_1')));
  assert(lsCalls.slice(lsBefore).some((c) => c.method === 'DELETE' && c.path === '/v1/subscriptions/903'), 'an active subscription can be cancelled at Lemon Squeezy (used when deleting the account)');
  const goneOk = await billingMod.cancelSubscription({ billing: { subscriptionId: 'gone', status: 'active' } }).then(() => true, () => false);
  const brokenOk = await billingMod.cancelSubscription({ billing: { subscriptionId: 'broken', status: 'active' } }).then(() => true, () => false);
  assert(goneOk && !brokenOk, 'a subscription already gone at Lemon Squeezy counts as cancelled; a server error stops the deletion');
  wh = await sendHook({ meta: { event_name: 'subscription_expired', test_mode: true }, data: Object.assign(sub('expired', 'Agency Monthly', { test_mode: true, ends_at: iso(now - DAY), updated_at: iso(now + 60000) }), { id: '903' }) });
  assert(JSON.parse(db.get('user:user_1')).plan === 'free', 'tester test subscription expiring returns to free');
  delete process.env.BILLING_TEST_EMAILS;
  lsTest = false;
  require('../api/_lib/billing')._reset();
  ls.close();

  console.log('6a. plans and billing (Polar)');
  const pCalls = [];
  const polarProducts = [
    // another Silit Labs product in the same Polar organization, listed first: must never be picked
    { id: 'p-other', name: 'Clinic Kit Pro Monthly', recurring_interval: 'month', is_recurring: true, metadata: { plan: 'studio' } },
    { id: 'p-solo-m', name: 'Flowdeck Solo Monthly', recurring_interval: 'month', is_recurring: true, metadata: { plan: 'solo', sites: 5 } },
    { id: 'p-studio-m', name: 'Flowdeck Studio Monthly', recurring_interval: 'month', is_recurring: true, metadata: { plan: 'studio', sites: 15 } },
    { id: 'p-agency-m', name: 'Flowdeck Agency Monthly', recurring_interval: 'month', is_recurring: true, metadata: { plan: 'agency', sites: 40 } },
    { id: 'p-solo-y', name: 'Flowdeck Solo Yearly', recurring_interval: 'year', is_recurring: true, metadata: { plan: 'solo', sites: 5 } },
    { id: 'p-studio-y', name: 'Flowdeck Studio Yearly', recurring_interval: 'year', is_recurring: true, metadata: { plan: 'studio', sites: 15 } },
    { id: 'p-agency-y', name: 'Flowdeck Agency Yearly', recurring_interval: 'year', is_recurring: true, metadata: { plan: 'agency', sites: 40 } }
  ];
  const pol = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname.replace(/^\/sandbox/, '');
    const body = ['POST', 'PATCH'].includes(req.method) ? await readJSON(req) : null;
    pCalls.push({ method: req.method, path, search: u.search, body, auth: req.headers.authorization, version: req.headers['polar-version'] });
    if (req.method === 'GET' && path === '/v1/products/') return json(res, 200, { items: polarProducts, pagination: { total_count: polarProducts.length, max_page: 1 } });
    if (req.method === 'POST' && path === '/v1/checkouts/') return json(res, 201, { id: 'co1', status: 'open', url: 'https://buy.polar.sh/polar_c_abc' });
    if (req.method === 'POST' && path === '/v1/customer-sessions/') return json(res, 201, { id: 'cs1', customer_id: body.customer_id, customer_portal_url: 'https://polar.sh/silitlabs/portal?customer_session_token=fresh' });
    if (req.method === 'PATCH' && path === '/v1/subscriptions/gone') return json(res, 404, { error: 'ResourceNotFound', detail: 'Not found' });
    if (req.method === 'PATCH' && path === '/v1/subscriptions/done') return json(res, 403, { error: 'AlreadyCanceledSubscription', detail: 'This subscription is already canceled or will be at the end of the period.' });
    if (req.method === 'PATCH' && path === '/v1/subscriptions/broken') return json(res, 500, { detail: 'server error' });
    if (req.method === 'PATCH' && path.startsWith('/v1/subscriptions/')) return json(res, 200, { id: path.split('/').pop(), status: 'active', cancel_at_period_end: true });
    json(res, 404, { detail: 'Not found' });
  });
  const polPort = await listen(pol);
  const polarSecret = 'whsec_' + crypto.randomBytes(24).toString('base64');
  Object.assign(process.env, { POLAR_ACCESS_TOKEN: 'polar_oat_test', POLAR_WEBHOOK_SECRET: polarSecret, POLAR_API_BASE: 'http://127.0.0.1:' + polPort });
  billingMod._reset();
  assert(billingMod.provider() === 'polar' && billingMod.providerName() === 'Polar', 'a Polar access token switches payments to Polar');
  process.env.BILLING_PROVIDER = 'lemonsqueezy';
  assert(billingMod.provider() === 'lemonsqueezy', 'BILLING_PROVIDER=lemonsqueezy keeps Lemon Squeezy even with a Polar token');
  delete process.env.BILLING_PROVIDER;

  const polPage = await request(port, 'GET', '/app/settings', { headers: { Cookie: session } });
  assert(polPage.body.includes('/app/billing/checkout') && polPage.body.includes('Payments are handled by Polar'), 'settings shows Polar checkout buttons');
  const pco = await post('/app/billing/checkout', { plan: 'studio', interval: 'yearly' });
  const pCo = pCalls.find((c) => c.path === '/v1/checkouts/');
  const pList = pCalls.find((c) => c.path === '/v1/products/');
  assert(pco.status === 302 && pco.headers.location === 'https://buy.polar.sh/polar_c_abc', 'checkout redirects to Polar');
  assert(pCo && pCo.auth === 'Bearer polar_oat_test' && pCo.version === '2026-10' && pList && /is_archived=false/.test(pList.search), 'Polar calls carry the token and the pinned API version, archived products are skipped');
  assert(pCo.body.products.length === 1 && pCo.body.products[0] === 'p-studio-y', 'checkout uses the Flowdeck Studio Yearly product, not another product with the same plan metadata');
  assert(pCo.body.metadata.user_id === 'user_1' && pCo.body.metadata.sig === billingMod.sign('user_1') && pCo.body.success_url === 'https://app.test/app/settings?upgraded=1' && pCo.body.return_url === 'https://app.test/app/settings#plan' && pCo.body.customer_email === 'owner@agency.com', 'checkout carries the signed user id, the return links and the email');
  const psig = pCo.body.metadata.sig;

  const swSign = (id, ts, raw, key) => 'v1,' + crypto.createHmac('sha256', key).update(`${id}.${ts}.${raw}`).digest('base64');
  let evtN = 0;
  const sendPolar = async (evt, opts = {}) => {
    const raw = JSON.stringify(evt);
    const id = 'msg_' + (++evtN);
    const ts = opts.ts || Math.floor(Date.now() / 1000);
    const key = opts.key || Buffer.from(polarSecret.slice(6), 'base64');
    const r = await hook.POST(new Request('https://app.test/billing/webhook', { method: 'POST', headers: { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': swSign(id, ts, raw, key), 'content-type': 'application/json' }, body: raw }));
    return { status: r.status, body: await r.json() };
  };
  const prod = (id) => polarProducts.find((p) => p.id === id);
  let pmod = now;
  const psub = (status, productId, extra) => Object.assign({
    id: 'ps_1', status, cancel_at_period_end: false, current_period_start: iso(now), current_period_end: iso(now + 365 * DAY), ends_at: null, ended_at: null,
    customer_id: 'cust_1', customer: { id: 'cust_1', email: 'owner@agency.com', external_id: null }, product_id: productId, product: prod(productId),
    recurring_interval: prod(productId).recurring_interval, metadata: { user_id: 'user_1', sig: psig, app: 'flowdeck' }, created_at: iso(now - 1000), modified_at: iso(pmod += 1000)
  }, extra || {});
  const pevt = (type, data) => ({ type, timestamp: iso(Date.now()), api_version: '2026-10', data });

  let pw = await sendPolar(pevt('subscription.created', psub('active', 'p-studio-y')), { key: Buffer.from('not the secret') });
  assert(pw.status === 401, 'Polar webhook with a bad signature is rejected');
  pw = await sendPolar(pevt('subscription.created', psub('active', 'p-studio-y')), { ts: Math.floor(Date.now() / 1000) - 600 });
  assert(pw.status === 401, 'Polar webhook older than 5 minutes is rejected (replay)');
  pw = await sendPolar(pevt('subscription.created', psub('active', 'p-agency-m', { id: 'ps_forged', metadata: { user_id: 'user_1', sig: 'forged' } })));
  assert(pw.status === 202 && pw.body.ignored === 'no user' && JSON.parse(db.get('user:user_1')).plan === 'free', 'Polar webhook with a forged user id is ignored');
  pw = await sendPolar(pevt('subscription.created', psub('active', 'p-other', { id: 'ps_other' })));
  assert(pw.status === 202 && pw.body.ignored === 'not a Flowdeck product' && JSON.parse(db.get('user:user_1')).plan === 'free', 'events for other Silit Labs products are ignored');
  pw = await sendPolar(pevt('order.paid', { id: 'ord_1' }));
  assert(pw.status === 202 && pw.body.ignored === 'order.paid', 'non-subscription events are acknowledged and ignored');
  pw = await sendPolar(pevt('subscription.created', psub('active', 'p-studio-y')));
  let pu = JSON.parse(db.get('user:user_1'));
  assert(pw.status === 200 && pu.plan === 'studio' && pu.billing.provider === 'polar' && pu.billing.interval === 'yearly' && pu.billing.subscriptionId === 'ps_1' && pu.billing.customerId === 'cust_1', 'subscription.created upgrades the user to Studio through Polar');
  assert(JSON.parse(db.get('site:siteC')).monitored, 'paused third site is monitored after the Polar upgrade');
  pw = await sendPolar(pevt('subscription.active', psub('active', 'p-studio-y')), { key: Buffer.from(polarSecret, 'utf8') });
  assert(pw.status === 200 && pw.body.ok, 'a secret made before 8 Sep 2026 (whole whsec string as the key) is accepted too');

  const ppor = await request(port, 'GET', '/app/billing/portal', { headers: { Cookie: session } });
  const pSess = pCalls.filter((c) => c.path === '/v1/customer-sessions/').pop();
  assert(ppor.status === 302 && ppor.headers.location === 'https://polar.sh/silitlabs/portal?customer_session_token=fresh' && pSess.body.customer_id === 'cust_1' && pSess.body.return_url === 'https://app.test/app/settings#plan', 'Manage billing opens a fresh signed-in Polar portal');

  pw = await sendPolar(pevt('subscription.canceled', psub('active', 'p-studio-y', { cancel_at_period_end: true, canceled_at: iso(now), ends_at: iso(now + 30 * DAY) })));
  pu = JSON.parse(db.get('user:user_1'));
  const cancPage = await request(port, 'GET', '/app/settings', { headers: { Cookie: session } });
  assert(pu.plan === 'studio' && pu.billing.status === 'cancelled' && cancPage.body.includes('Cancelled, active until'), 'cancelled at period end keeps the plan and says until when');
  assert(!billingMod.hasLiveSubscription(pu), 'a subscription already cancelled at period end is not cancelled again on account deletion');
  const lateRevoke = pevt('subscription.revoked', psub('canceled', 'p-studio-y', { ended_at: iso(now), modified_at: iso(now - 5000) }));
  pw = await sendPolar(lateRevoke);
  assert(pw.body.ignored === 'stale event' && JSON.parse(db.get('user:user_1')).plan === 'studio', 'a late, older Polar webhook does not overwrite a newer one');
  pw = await sendPolar(pevt('subscription.uncanceled', psub('active', 'p-studio-y')));
  pu = JSON.parse(db.get('user:user_1'));
  assert(pu.plan === 'studio' && pu.billing.status === 'active' && pu.billing.renewsAt, 'uncancelled subscription renews again');
  pw = await sendPolar(pevt('subscription.past_due', psub('past_due', 'p-studio-y')));
  const pdPage = await request(port, 'GET', '/app/settings', { headers: { Cookie: session } });
  assert(JSON.parse(db.get('user:user_1')).plan === 'studio' && pdPage.body.includes('payment failed'), 'past due keeps the plan and asks for a new card');
  pw = await sendPolar(pevt('subscription.updated', psub('active', 'p-agency-m')));
  pu = JSON.parse(db.get('user:user_1'));
  assert(pu.plan === 'agency' && pu.billing.interval === 'monthly', 'a plan change in the Polar portal moves the user to the new plan');
  pw = await sendPolar(pevt('subscription.revoked', psub('canceled', 'p-agency-m', { ended_at: iso(now), ends_at: iso(now) })));
  pu = JSON.parse(db.get('user:user_1'));
  const monitoredP = ['siteA', 'siteB', 'siteC'].filter((id) => JSON.parse(db.get('site:' + id)).monitored);
  assert(pu.plan === 'free' && pu.billing.status === 'expired' && monitoredP.length === 2 && !monitoredP.includes('siteC'), 'revoked subscription drops to free and pauses the newest site');

  const pBefore = pCalls.length;
  await billingMod.cancelSubscription({ billing: { provider: 'polar', subscriptionId: 'ps_9', status: 'active' } });
  const pPatch = pCalls.slice(pBefore).find((c) => c.method === 'PATCH');
  assert(pPatch && pPatch.path === '/v1/subscriptions/ps_9' && pPatch.body.cancel_at_period_end === true, 'deleting the account cancels the Polar subscription at period end');
  const pGone = await billingMod.cancelSubscription({ billing: { provider: 'polar', subscriptionId: 'gone', status: 'active' } }).then(() => true, () => false);
  const pDone = await billingMod.cancelSubscription({ billing: { provider: 'polar', subscriptionId: 'done', status: 'active' } }).then(() => true, () => false);
  const pBroken = await billingMod.cancelSubscription({ billing: { provider: 'polar', subscriptionId: 'broken', status: 'active' } }).then(() => true, () => false);
  assert(pGone && pDone && !pBroken, 'a Polar subscription already gone or already cancelled counts as cancelled; a server error stops the deletion');
  const lsBefore2 = lsCalls.length;
  const lsRec = await billingMod.cancelSubscription({ billing: { subscriptionId: 'old-ls', status: 'active' } }).then(() => true, () => false);
  assert(!lsRec && lsCalls.length === lsBefore2 && !pCalls.some((c) => c.path.includes('old-ls')), 'an old Lemon Squeezy subscription is never sent to Polar');

  // Polar sandbox: only testers can buy, sandbox payments never change a real user's plan
  process.env.POLAR_API_BASE = 'http://127.0.0.1:' + polPort + '/sandbox';
  billingMod._reset();
  const sbPage = await request(port, 'GET', '/app/settings', { headers: { Cookie: session } });
  assert(!sbPage.body.includes('/app/billing/checkout') && sbPage.body.includes('Paid plans are opening shortly'), 'Polar sandbox hides checkout buttons from users');
  const sbCo = await post('/app/billing/checkout', { plan: 'solo', interval: 'monthly' });
  assert(sbCo.status === 503, 'Polar sandbox checkout is refused for users');
  pw = await sendPolar(pevt('subscription.created', psub('active', 'p-solo-m', { id: 'ps_sb' })));
  assert(pw.body.ignored === 'test mode' && JSON.parse(db.get('user:user_1')).plan === 'free', 'Polar sandbox payment does not upgrade a real user');
  process.env.BILLING_TEST_EMAILS = 'owner@agency.com';
  const sbTester = await post('/app/billing/checkout', { plan: 'solo', interval: 'monthly' });
  assert(sbTester.status === 302 && sbTester.headers.location === 'https://buy.polar.sh/polar_c_abc', 'tester can buy in the Polar sandbox');
  delete process.env.BILLING_TEST_EMAILS;

  ['POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET', 'POLAR_API_BASE'].forEach((k) => delete process.env[k]);
  billingMod._reset();
  pol.close();

  console.log('6b. install from the Marketplace link (no state, no redirect_uri) signs in');
  const inst = await request(port, 'GET', '/callback?code=install-code');
  assert(inst.status === 302 && inst.headers.location.startsWith('/app') && /fd_session=/.test(cookiesFrom(inst)), 'Marketplace install callback reaches the dashboard');
  const instDash = await request(port, 'GET', '/app', { headers: { Cookie: cookiesFrom(inst) } });
  assert(instDash.status === 200 && instDash.body.includes('Acme Dental'), 'dashboard opens after a Marketplace install');
  const bad = await request(port, 'GET', '/callback?code=wrong-code');
  assert(bad.status === 400 && bad.body.includes('Could not connect to Webflow'), 'a bad code shows an error page, not a crash');
  const forged = await request(port, 'GET', '/callback?code=good-code&state=forged');
  assert(forged.status === 400 && forged.body.includes('Sign in expired'), 'a state without the matching cookie is rejected before the token exchange');
  const denied = await request(port, 'GET', '/callback?error=access_denied&error_description=The+user+denied+access');
  assert(denied.status === 400 && denied.body.includes('Authorization cancelled'), 'denying on the Webflow consent screen shows Authorization cancelled');
  const conns = JSON.parse(db.get('user:user_1')).connections;
  assert(conns.length === 1, 'a new authorization replaces the old connection instead of piling up');
  assert(wfState.revokeCalls.length === 1 && wfState.revokeCalls[0].access_token === 'tok_abc', 'the replaced token is revoked at Webflow');

  console.log('6c. returning users sign in with an email link, not OAuth');
  const lp = await request(port, 'GET', '/login');
  assert(lp.status === 200 && lp.body.includes('Email me a sign in link'), 'sign in page');
  const before = emails.length;
  const unknown = await request(port, 'POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ email: 'nobody@else.com' }) });
  assert(unknown.status === 302 && unknown.headers.location === '/login?sent=1' && emails.length === before, 'unknown email gets the same answer and no email');
  const ask = await request(port, 'POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ email: 'Owner@Agency.com' }) });
  const mail = emails[emails.length - 1];
  const link = (mail && mail.text.match(/https:\/\/app\.test(\/l\/[\w-]+)/) || [])[1];
  assert(ask.status === 302 && emails.length === before + 1 && mail.to[0] === 'owner@agency.com' && !!link, 'sign in link emailed to the account email');
  const again = await request(port, 'POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ email: 'owner@agency.com' }) });
  assert(again.status === 302 && emails.length === before + 1, 'one link per minute per address');
  const view = await request(port, 'GET', link);
  assert(view.status === 200 && view.body.includes('action="' + link + '"'), 'opening the link only shows a button (mail scanners cannot use it up)');
  const use = await request(port, 'POST', link, { headers: { Origin: 'https://app.test' } });
  assert(use.status === 302 && use.headers.location === '/app' && /fd_session=/.test(cookiesFrom(use)), 'pressing the button signs in');
  const reuse = await request(port, 'POST', link, { headers: { Origin: 'https://app.test' } });
  assert(reuse.status === 400 && reuse.body.includes('Link expired'), 'a used link does not work again');
  const s2 = cookiesFrom(use);
  const p2 = (pp, data) => request(port, 'POST', pp, { headers: { Cookie: s2, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form(data) });

  console.log('6d. the URL to check must be on the site\'s own domains');
  const evil = await p2('/app/site/settings', { id: 'siteA', client: 'Acme', plan: 'cms', checkUrl: 'http://169.254.169.254/latest/meta-data', alerts: '1' });
  assert(evil.status === 400 && evil.body.includes('URL not allowed'), 'a URL outside the site domains is refused');
  const own = await p2('/app/site/settings', { id: 'siteA', client: 'Acme', plan: 'cms', checkUrl: 'http://127.0.0.1:' + aPort + '/contact', alerts: '1' });
  assert(own.status === 302 && JSON.parse(db.get('site:siteA')).settings.checkUrl.endsWith('/contact'), 'a path on the site domain is accepted');
  await p2('/app/site/settings', { id: 'siteA', client: 'Acme', plan: 'cms', checkUrl: '', alerts: '1' });

  console.log('7. settings, remove site, delete account');
  const st = await request(port, 'POST', '/app/settings', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form({ alertEmail: 'alerts@agency.com', brand: 'Studio X', alerts: '1', digest: '1' }) });
  assert(st.status === 302 && JSON.parse(db.get('user:user_1')).settings.brand === 'Studio X', 'user settings saved');
  const rm = await request(port, 'POST', '/app/site/remove', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form({ id: 'siteB' }) });
  assert(rm.status === 302 && !db.has('site:siteB') && !JSON.parse(db.get('user:user_1')).siteIds.includes('siteB'), 'site removed');
  const del = await request(port, 'POST', '/app/delete', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: '' });
  assert(del.status === 302 && !db.has('user:user_1') && !db.has('site:siteA'), 'account and sites deleted');
  const store = require('../api/_lib/store');
  assert(store.limitFor({ plan: 'free', email: 'reviewer@webflow.com' }) === 40 && store.limitFor({ plan: 'free', email: 'x@other.com' }) === 2, 'Webflow review accounts get the Agency limit');

  console.log('8. uninstall in Webflow: token deleted, sites removed, API calls stop');
  const re = await request(port, 'GET', '/callback?code=install-code');
  const s3 = cookiesFrom(re);
  assert(re.status === 302 && JSON.parse(db.get('user:user_1')).siteIds.length === 3, 'reinstalled with 3 sites');
  wfState.revoked = true;
  process.env.REVOKE_CONFIRM_MS = '600000';
  const firstStrike = JSON.parse((await request(port, 'GET', '/cron/sync?key=cronkey')).body);
  const u8a = JSON.parse(db.get('user:user_1'));
  assert(firstStrike.results.some((x) => x.revokedPending) && u8a.connections.length === 1 && u8a.connections[0].revokedSince && db.has('site:siteA'), 'one 401 from Webflow does not delete anything yet');
  process.env.REVOKE_CONFIRM_MS = '0';
  const syncR = await request(port, 'GET', '/cron/sync?key=cronkey');
  const u8 = JSON.parse(db.get('user:user_1'));
  assert(syncR.status === 200 && u8.connections.length === 0 && u8.siteIds.length === 0 && !db.has('site:siteA') && !db.has('site:siteB'), 'revoked authorization: token and its sites deleted');
  const syncAgain = JSON.parse((await request(port, 'GET', '/cron/sync?key=cronkey')).body);
  assert(syncAgain.synced === 0, 'no more Webflow API calls for that connection');
  const d8 = await request(port, 'GET', '/app', { headers: { Cookie: s3 } });
  assert(d8.status === 200 && d8.body.includes('Webflow access for') && d8.body.includes('deleted the stored token'), 'the user is told once on the dashboard');
  wfState.revoked = false;

  console.log('9. disconnect in Settings revokes the token at Webflow');
  const re2 = await request(port, 'GET', '/callback?code=install-code');
  const s4 = cookiesFrom(re2);
  const connId = JSON.parse(db.get('user:user_1')).connections[0].id;
  const calls = wfState.revokeCalls.length;
  const dis = await request(port, 'POST', '/app/connection/remove', { headers: { Cookie: s4, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form({ id: connId }) });
  const u9 = JSON.parse(db.get('user:user_1'));
  assert(dis.status === 302 && dis.headers.location.startsWith('/app/settings?notice=') && u9.connections.length === 0 && u9.siteIds.length === 0, 'disconnect removes the connection and its sites');
  assert(wfState.revokeCalls.length === calls + 1 && wfState.revokeCalls[calls].client_secret === 'sec', 'disconnect calls Webflow revoke_authorization');
  const so = await request(port, 'GET', '/logout', { headers: { Cookie: s4 } });
  assert(so.status === 302 && wfState.revokeCalls.length === calls + 1, 'signing out does not revoke Webflow access');

  const health = await request(port, 'GET', '/health');
  assert(health.status === 200 && health.body === 'ok', 'health ok');

  console.log('10. hardening');
  const checksMod = require('../api/_lib/checks');
  // redirects are followed only on the site's own hosts
  const inner = http.createServer((req, res) => { res.writeHead(200); res.end('internal'); });
  const innerPort = await listen(inner);
  let innerHits = 0; inner.on('request', () => innerHits++);
  const hop = http.createServer((req, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:' + innerPort + '/latest/meta-data/' }); res.end(); });
  const hopPort = await listen(hop);
  const r1 = await checksMod.httpCheck('http://127.0.0.1:' + hopPort + '/', 3000, ['127.0.0.1:' + hopPort]);
  assert(r1.code === 302 && innerHits === 0, 'a redirect to another host is not followed');
  const r2 = await checksMod.httpCheck('http://127.0.0.1:' + hopPort + '/', 3000, ['127.0.0.1:' + hopPort, '127.0.0.1:' + innerPort]);
  assert(r2.code === 200 && innerHits === 1, 'a redirect within the site hosts is followed');
  delete process.env.ALLOW_PRIVATE_CHECKS;
  const r3 = await checksMod.httpCheck('http://127.0.0.1:' + innerPort + '/', 3000, []);
  assert(r3.error === 'blocked address' && innerHits === 1, 'checks never request private or loopback addresses');
  assert(checksMod.privateIp('169.254.169.254') && checksMod.privateIp('10.1.2.3') && checksMod.privateIp('::1') && checksMod.privateIp('::ffff:127.0.0.1') && !checksMod.privateIp('34.120.1.1'), 'private address ranges recognised');
  process.env.ALLOW_PRIVATE_CHECKS = '1';
  inner.close(); hop.close();
  // 30-day uptime from daily totals
  const stx = {};
  checksMod.addDaily(stx, { t: Date.now() - 20 * DAY, ok: false, ms: 100 });
  checksMod.addDaily(stx, { t: Date.now(), ok: true, ms: 300 });
  const sum30 = checksMod.summarizeDaily(stx.daily, Date.now() - 30 * DAY);
  assert(sum30.total === 2 && sum30.uptime === 50 && sum30.avgMs === 200, 'daily totals give the 30-day uptime');
  // client report: SSL text and labels
  const htmlMod = require('../api/_lib/html');
  const repHtml = htmlMod.report({ settings: { brand: '' } }, { url: 'https://x.test', name: 'X', settings: {}, status: { sslExpiresAt: Date.now() - DAY, daily: stx.daily } }, [], Date.now());
  assert(repHtml.includes("Expired") && !repHtml.includes(">Valid<") && repHtml.includes("50%"), 'report shows an expired certificate as Expired and 30-day uptime from daily totals');
  // alert emails are retried until delivered
  const alertsMod = require('../api/_lib/alerts');
  const downSite = { id: 'siteZ', name: 'Zed', url: 'https://zed.test', settings: { alerts: true }, status: { fails: 3, code: 500 } };
  const alertUser = { email: 'a@b.test', settings: { alerts: true, alertEmail: 'a@b.test' } };
  resendFail = true;
  const fail1 = await alertsMod.process(downSite, alertUser, Date.now());
  assert(fail1.some((x) => x.type === 'down' && x.state === 'retry') && !db.has('alert:siteZ:down'), 'a failed alert email is not marked as sent');
  assert(!db.has('alertfail:siteZ:down'), 'a temporary email failure (server error) is simply retried on the next run');
  resendFail = 422;
  const fail2 = await alertsMod.process(downSite, alertUser, Date.now());
  resendFail = false;
  const wait1 = await alertsMod.process(downSite, alertUser, Date.now());
  assert(fail2.some((x) => x.state === 'retry') && wait1.some((x) => x.type === 'down' && x.state === 'waiting') && !db.has('alert:siteZ:down'), 'an email the service refuses backs off instead of hammering it');
  const ok1 = await alertsMod.process(downSite, alertUser, Date.now() + 6 * 60000);
  assert(ok1.some((x) => x.type === 'down' && x.state === 'opened') && db.has('alert:siteZ:down') && !db.has('alertfail:siteZ:down') && emails.slice(-1)[0].subject.includes('Zed is down'), 'the alert email goes out once the wait is over');
  // a check result never overwrites settings the user changed meanwhile
  const storeMod = require('../api/_lib/store');
  db.set('site:siteT', JSON.stringify({ id: 'siteT', name: 'T', url: 'https://t.test', monitored: true, settings: { client: 'Old' }, status: { code: 200 } }));
  const tRec = JSON.parse(db.get('site:siteT')); // what a check run read at its start
  const changed = JSON.parse(db.get('site:siteT')); changed.monitored = false; changed.pausedByUser = true; changed.settings.client = 'Renamed Client';
  db.set('site:siteT', JSON.stringify(changed)); // the user changes the site while the check runs
  await storeMod.saveSiteStatus('siteT', Object.assign({}, tRec.status, { code: 299 }));
  const merged = JSON.parse(db.get('site:siteT'));
  assert(merged.status.code === 299 && merged.monitored === false && merged.pausedByUser === true && merged.settings.client === 'Renamed Client', 'saving a check result keeps settings changed during the check');
  db.delete('site:siteT');
  assert((await storeMod.saveSiteStatus('nope', {})) === null && !db.has('site:nope'), 'a check result for a removed site does not bring it back');
  // an old backoff record is forgotten once the problem is over
  db.set('alertfail:siteY:down', JSON.stringify({ n: 3, until: Date.now() + 3600000 }));
  await alertsMod.process({ id: 'siteY', name: 'Y', url: 'https://y.test', settings: { alerts: true }, status: { fails: 0 } }, alertUser, Date.now());
  assert(!db.has('alertfail:siteY:down'), 'a recovered site does not carry an old email backoff into its next outage');
  // signed notices only
  const s10 = cookiesFrom(await request(port, 'GET', '/callback?code=install-code'));
  const forgedNotice = await request(port, 'GET', '/app?notice=' + encodeURIComponent('Your account is suspended, call 555'), { headers: { Cookie: s10 } });
  assert(forgedNotice.status === 200 && !forgedNotice.body.includes('suspended'), 'a notice typed into the URL is not shown');
  const nsig = (uid, t) => crypto.createHmac('sha256', process.env.SESSION_SECRET).update('notice:' + uid + ':' + t).digest('hex').slice(0, 16);
  const otherUser = await request(port, 'GET', '/app?notice=' + encodeURIComponent('Hello other user') + '&ns=' + nsig('user_2', 'Hello other user'), { headers: { Cookie: s10 } });
  const ownUser = await request(port, 'GET', '/app?notice=' + encodeURIComponent('Hello own user') + '&ns=' + nsig('user_1', 'Hello own user'), { headers: { Cookie: s10 } });
  assert(!otherUser.body.includes('Hello other user') && ownUser.body.includes('Hello own user'), 'a notice signed for another account is not shown');
  // sign in: index backfill and limits
  const uRec = JSON.parse(db.get('user:user_1'));
  db.delete('email:' + uRec.email); db.delete('migr:email-index');
  const rebuilt = await require('../api/_lib/store').ensureEmailIndex();
  const rebuiltAgain = await require('../api/_lib/store').ensureEmailIndex();
  assert(rebuilt >= 1 && rebuiltAgain === 0 && db.has('email:' + uRec.email), 'the email index is rebuilt once for older accounts');
  const loginFrom = (ip, addr) => request(port, 'POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-For': ip }, body: form({ email: addr }) });
  for (let i = 0; i < 10; i++) await loginFrom('203.0.113.9', 'nobody' + i + '@example.com');
  db.delete('loginrl:' + uRec.email);
  const mailsBefore = emails.length;
  await loginFrom('203.0.113.9', uRec.email);
  assert(emails.length === mailsBefore, 'more than 10 sign in requests from one IP in 10 minutes send nothing');
  await loginFrom('198.51.100.7', uRec.email);
  assert(emails.length === mailsBefore + 1, 'another IP can still sign in');
  const longEmail = await loginFrom('198.51.100.8', 'a'.repeat(300) + '@example.com');
  assert(longEmail.status === 302 && longEmail.headers.location === '/login?bad=1', 'over-long email addresses are refused');
  const allBefore = db.get('rl:login-all');
  for (let i = 0; i < 5; i++) await loginFrom('198.51.100.' + (20 + i), 'junk' + i + '@example.com');
  assert(db.get('rl:login-all') === allBefore, 'unknown addresses do not use up the shared sign in budget');
  for (let i = 0; i < 10; i++) await loginFrom('2001:db8:aa:bb::' + (i + 1).toString(16), 'nobody' + i + '@example.com');
  db.delete('loginrl:' + uRec.email);
  const mails6 = emails.length;
  await loginFrom('2001:db8:aa:bb:ffff::1', uRec.email);
  assert(emails.length === mails6, 'IPv6 addresses in one /64 share the per-IP limit');
  // weekly digest: one per week, with a Tuesday catch-up
  const jobsMod = require('../api/_lib/jobs');
  const dgMon = Date.parse('2030-01-07T08:00:00Z'), dgTue = Date.parse('2030-01-08T08:00:00Z'), dgWed = Date.parse('2030-01-09T08:00:00Z');
  const dTue1 = await jobsMod.runDigest(dgTue);
  const dMon = await jobsMod.runDigest(dgMon);
  const dWed = await jobsMod.runDigest(dgWed);
  const dMon2 = await jobsMod.runDigest(Date.parse('2030-01-14T08:00:00Z'));
  assert(dTue1.sent === 1 && dMon.sent === 0 && dWed.skipped && dMon2.sent === 1, 'weekly digest: Tuesday catches up a missed Monday, never twice a week, next week sends again');

  // compressed IPv6 addresses in one /64 share the limit too
  for (let i = 0; i < 10; i++) await loginFrom('2001:db8:cc::' + (i + 1).toString(16), 'nobody' + i + '@example.com');
  db.delete('loginrl:' + uRec.email);
  const mails6b = emails.length;
  await loginFrom('2001:db8:cc:0:ffff::1', uRec.email);
  assert(emails.length === mails6b, 'compressed IPv6 forms of one /64 are counted together');
  // a digest already sent by the previous version this week is not sent again
  db.set('lock:digest:2030-01-21', JSON.stringify({ at: 1 }));
  const dLegacy = await jobsMod.runDigest(Date.parse('2030-01-21T09:00:00Z'));
  assert(dLegacy.skipped === 'already sent', 'a digest the previous version already sent this week is not repeated');
  // Webflow refuses one site while the token still works: nothing is deleted
  wfState.refusedSites = ['siteA'];
  const connBefore = JSON.parse(db.get('user:user_1')).connections.length;
  await request(port, 'GET', '/cron/sync?key=cronkey');
  await request(port, 'GET', '/cron/sync?key=cronkey');
  const uRef = JSON.parse(db.get('user:user_1'));
  const aRef = db.get('site:siteA') && JSON.parse(db.get('site:siteA'));
  assert(uRef.connections.length === connBefore && aRef && /refused access to this site/.test(aRef.syncError) && !uRef.connections[0].revokedSince, 'one refused site with a working token never deletes the connection');
  const refOne = await request(port, 'POST', '/app/sync', { headers: { Cookie: s10, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form({ id: 'siteA' }) });
  const refOnePage = refOne.headers.location && await request(port, 'GET', refOne.headers.location, { headers: { Cookie: s10 } });
  assert(refOne.headers.location.startsWith('/app/site?id=siteA&notice=') && refOnePage.body.includes('while your connection still works'), 'Refresh on the site page explains a refused site');
  wfState.refusedSites = [];

  // manual Refresh while Webflow refuses access: the user is told, nothing is deleted on the first refusal
  wfState.revoked = true;
  process.env.REVOKE_CONFIRM_MS = '600000';
  const sitesBefore = JSON.parse(db.get('user:user_1')).siteIds.length;
  const ref = await request(port, 'POST', '/app/sync', { headers: { Cookie: s10, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: '' });
  const refPage = ref.headers.location && await request(port, 'GET', ref.headers.location, { headers: { Cookie: s10 } });
  assert(ref.status === 302 && refPage && refPage.body.includes('Webflow refused access') && JSON.parse(db.get('user:user_1')).siteIds.length === sitesBefore, 'Refresh tells the user when Webflow refuses access and keeps the data on the first refusal');
  wfState.revoked = false;
  process.env.REVOKE_CONFIRM_MS = '0';

  console.log('11. cost guards: floods on public addresses never reach the database or Webflow');
  const from = (ip, method, p, extra) => request(port, method, p, Object.assign({}, extra || {}, { headers: Object.assign({ 'X-Forwarded-For': ip }, (extra && extra.headers) || {}) }));
  const rTok = 'AbCdEfGh12345678';
  db.set('user:cg_user', JSON.stringify({ id: 'cg_user', email: 'cg@agency.com', settings: { brand: 'CG Agency', alerts: true, digest: true }, connections: [], siteIds: ['cgSite'] }));
  db.set('site:cgSite', JSON.stringify({ id: 'cgSite', userId: 'cg_user', name: 'CG Site', url: 'https://cg.example', domains: [], monitored: false, settings: { reportToken: rTok, client: '', plan: 'unknown', alerts: true, checkUrl: '' }, status: {}, data: null }));
  db.set('report:' + rTok, JSON.stringify({ siteId: 'cgSite' }));

  const repOk = await from('192.0.2.10', 'GET', '/r/' + rTok);
  assert(repOk.status === 200 && /s-maxage=60/.test(repOk.headers['cache-control']) && /max-age=0/.test(repOk.headers['cache-control']) && repOk.headers['x-robots-tag'] === 'noindex', 'a report may stay on the CDN for one minute and is still noindex');
  let c0 = redisCalls;
  const badShapes = [await from('192.0.2.10', 'GET', '/r/abc'), await from('192.0.2.10', 'GET', '/r/' + 'a'.repeat(100)), await from('192.0.2.10', 'GET', '/r/abc%24def%21ghijkl')];
  assert(badShapes.every((r) => r.status === 404 && r.headers['cache-control'] === 'no-store') && redisCalls === c0, 'report links of an impossible shape get 404 without a database read');
  for (let i = 0; i < 60; i++) await from('192.0.2.11', 'GET', '/r/unknownTOKEN' + String(1000 + i));
  c0 = redisCalls;
  const flood = [];
  for (let i = 0; i < 5; i++) flood.push(await from('192.0.2.11', 'GET', '/r/unknownTOKEN' + String(2000 + i)));
  assert(flood.every((r) => r.status === 429 && r.headers['retry-after'] === '60') && redisCalls === c0, 'more than 60 report requests a minute from one address get 429 and no database read');
  const other = await from('192.0.2.12', 'GET', '/r/' + rTok);
  assert(other.status === 200, 'another address still sees the report');

  c0 = redisCalls;
  const badLink = await from('192.0.2.13', 'GET', '/l/short');
  assert(badLink.status === 400 && badLink.body.includes('Link expired') && redisCalls === c0, 'sign in links of an impossible shape are answered without a database read');
  for (let i = 0; i < 30; i++) await from('192.0.2.13', 'GET', '/l/' + 'x'.repeat(28) + String(1000 + i)); // the impossible shape above is not counted
  c0 = redisCalls;
  const linkFlood = await from('192.0.2.13', 'GET', '/l/' + 'x'.repeat(28) + '9999');
  assert(linkFlood.status === 429 && redisCalls === c0, 'more than 30 sign in link requests a minute from one address get 429 and no database read');

  const t0 = wfState.tokenCalls || 0;
  const longCode = await from('192.0.2.14', 'GET', '/callback?code=' + 'x'.repeat(600));
  assert(longCode.status === 400 && (wfState.tokenCalls || 0) === t0, 'an over-long authorization code is refused without asking Webflow');
  for (let i = 0; i < 20; i++) await from('192.0.2.14', 'GET', '/callback?code=bad' + i); // the over-long code above is not counted
  const t1 = wfState.tokenCalls || 0;
  const cbFlood = await from('192.0.2.14', 'GET', '/callback?code=bad-again');
  assert(t1 > t0 && cbFlood.status === 429 && (wfState.tokenCalls || 0) === t1, 'more than 20 callbacks a minute from one address get 429 and Webflow is not asked');

  for (let i = 0; i < 30; i++) await from('192.0.2.15', 'POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ email: 'flood' + i + '@example.com' }) });
  c0 = redisCalls;
  const loginFlood = [];
  for (let i = 0; i < 5; i++) loginFlood.push(await from('192.0.2.15', 'POST', '/login', { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ email: 'flood-more' + i + '@example.com' }) }));
  assert(loginFlood.every((r) => r.status === 302 && r.headers.location === '/login?sent=1') && redisCalls === c0, 'a sign in flood from one address gets the usual answer without touching the database');
  ['user:cg_user', 'site:cgSite', 'report:' + rTok].forEach((k) => db.delete(k));

  console.log(`\n${passed} passed, ${failed} failed`);
  [redis, siteA, siteB, resend, webflow, app].forEach((s) => s.close());
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
