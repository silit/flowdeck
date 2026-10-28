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
    case 'MGET': return a.map((k) => (alive(k) ? db.get(k) : null));
    case 'SET': {
      const nx = a.includes('NX'); const exI = a.indexOf('EX');
      if (nx && alive(a[0])) return null;
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
const redis = http.createServer(async (req, res) => {
  const body = await readJSON(req);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/pipeline') return json(res, 200, body.map((cmd) => { try { return { result: exec(cmd) }; } catch (e) { return { error: e.message }; } }));
  try { json(res, 200, { result: exec(body) }); } catch (e) { json(res, 400, { error: e.message }); }
});

/* ---- mock customer sites ---- */
let siteBStatus = 200;
const siteA = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html><body>A</body></html>'); });
const siteB = http.createServer((req, res) => { res.writeHead(siteBStatus, { 'Content-Type': 'text/html' }); res.end('<html><body>B</body></html>'); });

/* ---- mock Resend ---- */
const emails = [];
const resend = http.createServer(async (req, res) => { const body = await readJSON(req); emails.push(body); json(res, 200, { id: 'em_' + emails.length }); });

/* ---- mock Webflow ---- */
const DAY = 86400000;
const now = Date.now();
function iso(ms) { return new Date(ms).toISOString(); }
const wfState = { sites: [], submissions: {}, pages: {}, collections: {}, counts: {} };
const webflow = http.createServer(async (req, res) => {
  const body = await readJSON(req);
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/oauth/access_token') {
    if (body.code !== 'good-code' || body.client_id !== 'cid' || body.client_secret !== 'sec') return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, { access_token: 'tok_abc', token_type: 'bearer' });
  }
  if ((req.headers.authorization || '') !== 'Bearer tok_abc') return json(res, 401, { message: 'Unauthorized' });
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
    APP_URL: 'https://app.test', CRON_SECRET: 'cronkey', BETA_FREE_LIMIT: '2', SITE_URL_SCHEME: 'http',
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
  assert(sA.monitored && sB.monitored && !sC.monitored, 'third site paused by the beta limit of 2');
  assert(sA.data && sA.data.pages.issues === 4 && sA.data.pages.missingTitle.length === 1 && sA.data.pages.missingDesc.length === 1 && sA.data.pages.longDesc.length === 1 && sA.data.pages.dupTitle.length === 1, 'SEO analysis: missing title and description, long description, duplicate title; archived page ignored');
  assert(sA.data.forms.total7 === 2 && sA.data.forms.total30 === 3, 'form counts for 7 and 30 days');
  assert(sA.data.cms.total === 1940, 'CMS item total');
  assert(sA.status.up === true, 'initial check marks site A up');

  console.log('2. dashboard');
  const anon = await request(port, 'GET', '/app');
  assert(anon.status === 302 && anon.headers.location === '/auth', 'anonymous dashboard redirects to sign in');
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
  const unpub = emails.find((e) => e.subject.includes('unpublished changes'));
  assert(unpub && unpub.subject.includes('Blue Yachts'), 'unpublished-for-7-days alert fired for site B');
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
  r = await request(port, 'GET', '/cron/digest?key=cronkey&force=1');
  out = JSON.parse(r.body);
  assert(out.sent === 1 && emails[emails.length - 1].subject.includes('Weekly report') && emails[emails.length - 1].html.includes('Acme Dental Clinic'), 'weekly digest sent with the site table');
  r = await request(port, 'GET', '/cron/digest?key=cronkey&force=1');
  assert(JSON.parse(r.body).skipped === 'already sent today', 'digest not sent twice on the same day');

  console.log('6. settings, remove site, delete account');
  const st = await request(port, 'POST', '/app/settings', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form({ alertEmail: 'alerts@agency.com', brand: 'Studio X', alerts: '1', digest: '1' }) });
  assert(st.status === 302 && JSON.parse(db.get('user:user_1')).settings.brand === 'Studio X', 'user settings saved');
  const rm = await request(port, 'POST', '/app/site/remove', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: form({ id: 'siteB' }) });
  assert(rm.status === 302 && !db.has('site:siteB') && !JSON.parse(db.get('user:user_1')).siteIds.includes('siteB'), 'site removed');
  const del = await request(port, 'POST', '/app/delete', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://app.test' }, body: '' });
  assert(del.status === 302 && !db.has('user:user_1') && !db.has('site:siteA'), 'account and sites deleted');
  const health = await request(port, 'GET', '/health');
  assert(health.status === 200 && health.body === 'ok', 'health ok');

  console.log(`\n${passed} passed, ${failed} failed`);
  [redis, siteA, siteB, resend, webflow, app].forEach((s) => s.close());
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
