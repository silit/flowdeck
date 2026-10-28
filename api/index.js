/*
 * Flowdeck: one dashboard for every Webflow site an agency manages.
 * Single serverless entry point. vercel.json rewrites everything that is not a static file here,
 * with the original path in req.query.path.
 */
'use strict';

const wf = require('./_lib/webflow');
const store = require('./_lib/store');
const jobs = require('./_lib/jobs');
const checks = require('./_lib/checks');
const alerts = require('./_lib/alerts');
const html = require('./_lib/html');
const { seal, open, random, timingEqual } = require('./_lib/crypto');
const { syncSite } = require('./_lib/sync');

const ENV = () => ({
  clientId: process.env.WEBFLOW_CLIENT_ID || '',
  clientSecret: process.env.WEBFLOW_CLIENT_SECRET || '',
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  cronSecret: process.env.CRON_SECRET || '',
  betaFreeLimit: parseInt(process.env.BETA_FREE_LIMIT || '25', 10)
});

const SESSION_TTL = 30 * 86400;

/* ---------- http helpers ---------- */

function send(res, status, body, headers) {
  const h = Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {});
  res.statusCode = status;
  for (const k of Object.keys(h)) res.setHeader(k, h[k]);
  res.end(body);
}
function json(res, status, obj) { send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' }); }
function redirect(res, location, headers) { send(res, 302, '', Object.assign({ Location: location }, headers || {})); }

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function cookie(name, value, maxAge) {
  const parts = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'];
  if (maxAge != null) parts.push('Max-Age=' + maxAge);
  return parts.join('; ');
}
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    return Object.fromEntries(new URLSearchParams(String(req.body)));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (String(req.headers['content-type'] || '').includes('application/json')) {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}
function pathOf(req) {
  const u = new URL(req.url, 'http://local');
  let p = (req.query && req.query.path) ? String(req.query.path) : u.pathname.replace(/^\/api\/?/, '');
  return '/' + p.replace(/^\/+/, '').replace(/\/+$/, '');
}
function queryOf(req) {
  const u = new URL(req.url, 'http://local');
  const q = Object.fromEntries(u.searchParams);
  if (req.query) for (const k of Object.keys(req.query)) if (q[k] === undefined && k !== 'path') q[k] = req.query[k];
  delete q.path;
  return q;
}
function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer || '';
  if (!origin) return true; // older browsers; cookie is SameSite=Lax anyway
  try { return new URL(origin).host === new URL(ENV().appUrl || 'http://local').host || new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

/* ---------- auth ---------- */

async function currentUser(req) {
  const c = parseCookies(req);
  const s = c.fd_session ? open(c.fd_session) : null;
  if (!s || !s.u || (s.exp && s.exp < Date.now())) return null;
  const user = await store.getUser(s.u);
  if (user) user._limit = limitFor(user);
  return user;
}
function sessionCookie(userId) {
  return cookie('fd_session', seal({ u: userId, exp: Date.now() + SESSION_TTL * 1000 }), SESSION_TTL);
}
function limitFor(user) {
  const env = ENV();
  const base = store.PLAN_LIMITS[user.plan] || store.PLAN_LIMITS.free;
  // During the beta the free plan is raised to BETA_FREE_LIMIT sites
  return user.plan === 'free' && env.betaFreeLimit > 0 ? env.betaFreeLimit : base;
}

async function handleAuth(req, res) {
  const env = ENV();
  if (!env.clientId || !env.appUrl) return send(res, 500, html.errorPage('Not configured', 'WEBFLOW_CLIENT_ID and APP_URL must be set.', '/'));
  const state = random(16);
  redirect(res, wf.authorizeUrl({ clientId: env.clientId, redirectUri: env.appUrl + '/callback', state }), { 'Set-Cookie': cookie('fd_state', state, 600) });
}

async function handleCallback(req, res) {
  const env = ENV();
  const q = queryOf(req);
  const c = parseCookies(req);
  if (q.error) return send(res, 400, html.errorPage('Authorization cancelled', String(q.error_description || q.error), '/'));
  if (!q.code) return send(res, 400, html.errorPage('Missing code', 'Webflow did not return an authorization code.', '/'));
  if (q.state && c.fd_state && q.state !== c.fd_state) return send(res, 400, html.errorPage('State mismatch', 'The sign in request did not match. Start again.', '/'));

  let token;
  try { token = await wf.exchangeCode({ clientId: env.clientId, clientSecret: env.clientSecret, code: q.code, redirectUri: env.appUrl + '/callback' }); }
  catch (e) { return send(res, 400, html.errorPage('Could not sign in', e.message, '/')); }

  let info;
  try { info = await wf.authorizedBy(token); } catch (e) { return send(res, 400, html.errorPage('Could not read your Webflow user', e.message, '/')); }
  if (!info || !info.id) return send(res, 400, html.errorPage('Could not read your Webflow user', 'Webflow returned no user id.', '/'));

  let user = await store.getUser(info.id);
  if (!user) user = store.newUser(info);
  user.email = info.email || user.email;
  const conn = store.addConnection(user, token, info.email || '');

  let sitesMeta = [];
  try { sitesMeta = await wf.listSites(token); } catch (e) { sitesMeta = []; }
  const limit = limitFor(user);
  const notices = [];
  let added = 0;
  for (const meta of sitesMeta) {
    const existing = await store.getSite(meta.id);
    if (existing && existing.userId !== user.id) { notices.push(`${meta.displayName || meta.id} is already connected by another account.`); continue; }
    let site = existing || store.newSite(meta, user.id, conn.id);
    if (existing) { store.refreshMeta(site, meta); site.connectionId = conn.id; }
    const monitoredCount = user.siteIds.filter((id) => id !== site.id).length;
    site.monitored = existing ? site.monitored : monitoredCount < limit;
    await store.saveSite(site);
    if (!user.siteIds.includes(site.id)) { user.siteIds.push(site.id); added++; }
  }
  await store.saveUser(user);

  // First data for up to 5 sites right away, so the dashboard is not empty
  const fresh = (await store.getSites(user.siteIds)).filter((s) => s.monitored && !s.syncedAt).slice(0, 5);
  for (const site of fresh) {
    try {
      await syncSite(site, token, { pages: 200, collections: 15, submissions: 200 });
      const url = (site.settings && site.settings.checkUrl) || site.url;
      if (url) {
        const chk = await checks.httpCheck(url, 8000);
        site.status = Object.assign(site.status || {}, { lastCheckAt: chk.t, code: chk.code, ms: chk.ms, up: chk.ok ? true : null, fails: chk.ok ? 0 : 1, since: chk.t, error: chk.error || '' });
        await store.pushCheck(site.id, { t: chk.t, ok: chk.ok, code: chk.code, ms: chk.ms });
      }
      await store.saveSite(site);
    } catch (e) { /* the sync job will retry */ }
  }

  res.setHeader('Set-Cookie', [sessionCookie(user.id), cookie('fd_state', '', 0)]);
  redirect(res, '/app' + (notices.length ? '?notice=' + encodeURIComponent(notices.join(' ')) : (added ? '?added=' + added : '')));
}

/* ---------- app pages ---------- */

async function handleApp(req, res, user) {
  const q = queryOf(req);
  const sites = await store.getSites(user.siteIds || []);
  const checksBySite = {};
  for (const s of sites) checksBySite[s.id] = await store.recentChecks(s.id);
  let notice = q.notice ? html.esc(q.notice) : '';
  if (q.added) notice = `${html.esc(q.added)} site${q.added === '1' ? '' : 's'} connected. First data is loading; uptime starts within 5 minutes.`;
  if (q.synced) notice = 'Data refreshed.';
  send(res, 200, html.dashboard(user, sites, checksBySite, Date.now(), notice));
}

async function handleSync(req, res, user) {
  const sites = (await store.getSites(user.siteIds || [])).filter((s) => s.monitored).sort((a, b) => (a.syncedAt || 0) - (b.syncedAt || 0)).slice(0, 10);
  for (const site of sites) {
    const conn = user.connections.find((c) => c.id === site.connectionId);
    const token = conn && store.tokenOf(conn);
    if (!token) continue;
    const before = site.data && site.data.forms ? site.data.forms : null;
    try {
      await syncSite(site, token, { pages: 300, collections: 20, submissions: 300 });
      if (site.data && site.data.forms) site.data.forms.before30 = before ? Math.max(before.total30 || 0, before.before30 || 0) : 0;
      await store.saveSite(site);
    } catch (e) { /* keep going */ }
  }
  redirect(res, '/app?synced=1');
}

async function ownedSite(user, id) {
  if (!id || !(user.siteIds || []).includes(id)) return null;
  const site = await store.getSite(id);
  return site && site.userId === user.id ? site : null;
}

async function handleSitePage(req, res, user) {
  const q = queryOf(req);
  const site = await ownedSite(user, q.id);
  if (!site) return send(res, 404, html.errorPage('Site not found', 'That site is not connected to your account.'));
  const recent = await store.recentChecks(site.id);
  send(res, 200, html.siteDetail(user, site, recent, Date.now(), q.saved ? 'Settings saved.' : ''));
}

async function handleSiteSettings(req, res, user) {
  const b = await readBody(req);
  const site = await ownedSite(user, b.id);
  if (!site) return send(res, 404, html.errorPage('Site not found', 'That site is not connected to your account.'));
  site.settings.client = String(b.client || '').trim().slice(0, 80);
  site.settings.plan = ['unknown', 'basic', 'cms', 'business', 'enterprise'].includes(b.plan) ? b.plan : 'unknown';
  const url = String(b.checkUrl || '').trim();
  site.settings.checkUrl = /^https?:\/\/[^\s]+$/.test(url) ? url : '';
  site.settings.alerts = b.alerts === '1' || b.alerts === 'on';
  await store.saveSite(site);
  redirect(res, '/app/site?id=' + encodeURIComponent(site.id) + '&saved=1');
}

async function handleSiteReport(req, res, user) {
  const b = await readBody(req);
  const site = await ownedSite(user, b.id);
  if (!site) return send(res, 404, html.errorPage('Site not found', 'That site is not connected to your account.'));
  if (b.action === 'rotate' && site.settings.reportToken) {
    await store.deleteReport(site.settings.reportToken);
    site.settings.reportToken = '';
    await store.saveSite(site);
  }
  await store.ensureReportToken(site);
  redirect(res, '/app/site?id=' + encodeURIComponent(site.id));
}

async function handleSiteRemove(req, res, user) {
  const b = await readBody(req);
  const site = await ownedSite(user, b.id);
  if (!site) return send(res, 404, html.errorPage('Site not found', 'That site is not connected to your account.'));
  if (site.settings.reportToken) await store.deleteReport(site.settings.reportToken);
  for (const t of Object.keys(alerts.RULES)) await store.clearAlert(site.id, t);
  await store.deleteSite(site.id);
  user.siteIds = user.siteIds.filter((id) => id !== site.id);
  await store.saveUser(user);
  redirect(res, '/app?notice=' + encodeURIComponent(site.name + ' removed.'));
}

async function handleSettingsPage(req, res, user) {
  const q = queryOf(req);
  const sites = await store.getSites(user.siteIds || []);
  send(res, 200, html.settings(user, sites, q.saved ? 'Settings saved.' : ''));
}

async function handleSettingsSave(req, res, user) {
  const b = await readBody(req);
  const email = String(b.alertEmail || '').trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, html.errorPage('Check the email', 'That email address does not look right.', '/app/settings'));
  user.settings.alertEmail = email;
  user.settings.brand = String(b.brand || '').trim().slice(0, 80);
  user.settings.alerts = b.alerts === '1' || b.alerts === 'on';
  user.settings.digest = b.digest === '1' || b.digest === 'on';
  await store.saveUser(user);
  redirect(res, '/app/settings?saved=1');
}

async function handleDelete(req, res, user) {
  for (const id of user.siteIds || []) {
    const site = await store.getSite(id);
    if (site && site.userId === user.id) {
      if (site.settings.reportToken) await store.deleteReport(site.settings.reportToken);
      for (const t of Object.keys(alerts.RULES)) await store.clearAlert(site.id, t);
      await store.deleteSite(site.id);
    }
  }
  await store.deleteUser(user.id);
  res.setHeader('Set-Cookie', [cookie('fd_session', '', 0)]);
  redirect(res, '/?deleted=1');
}

async function handleReport(req, res, token) {
  const siteId = await store.siteIdForReport(token);
  const site = siteId ? await store.getSite(siteId) : null;
  if (!site || site.settings.reportToken !== token) return send(res, 404, html.errorPage('Report not found', 'This report link is no longer valid.', '/'));
  const user = await store.getUser(site.userId);
  const recent = await store.recentChecks(site.id);
  send(res, 200, html.report(user, site, recent, Date.now()), { 'X-Robots-Tag': 'noindex' });
}

/* ---------- cron ---------- */

function cronAuthorized(req) {
  const env = ENV();
  if (!env.cronSecret) return false;
  const q = queryOf(req);
  const given = req.headers['x-cron-secret'] || q.key || '';
  return given && timingEqual(given, env.cronSecret);
}

/* ---------- router ---------- */

module.exports = async function handler(req, res) {
  const path = pathOf(req);
  const method = (req.method || 'GET').toUpperCase();
  try {
    if (path === '/health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (path === '/auth') return handleAuth(req, res);
    if (path === '/callback') return handleCallback(req, res);
    if (path === '/logout') { res.setHeader('Set-Cookie', [cookie('fd_session', '', 0)]); return redirect(res, '/'); }
    if (path.startsWith('/r/')) return handleReport(req, res, path.slice(3));

    if (path.startsWith('/cron/')) {
      if (!cronAuthorized(req)) return json(res, 401, { error: 'unauthorized' });
      const force = queryOf(req).force === '1';
      if (path === '/cron/checks') return json(res, 200, await jobs.runChecks());
      if (path === '/cron/sync') return json(res, 200, await jobs.runSync());
      if (path === '/cron/digest') return json(res, 200, await jobs.runDigest(Date.now(), force));
      return json(res, 404, { error: 'unknown job' });
    }

    if (path === '/app' || path.startsWith('/app/')) {
      const user = await currentUser(req);
      if (!user) return redirect(res, '/auth');
      if (method === 'POST' && !sameOrigin(req)) return send(res, 403, html.errorPage('Blocked', 'Cross-site request blocked.'));
      if (path === '/app' && method === 'GET') return handleApp(req, res, user);
      if (path === '/app/sync' && method === 'POST') return handleSync(req, res, user);
      if (path === '/app/site' && method === 'GET') return handleSitePage(req, res, user);
      if (path === '/app/site/settings' && method === 'POST') return handleSiteSettings(req, res, user);
      if (path === '/app/site/report' && method === 'POST') return handleSiteReport(req, res, user);
      if (path === '/app/site/remove' && method === 'POST') return handleSiteRemove(req, res, user);
      if (path === '/app/settings' && method === 'GET') return handleSettingsPage(req, res, user);
      if (path === '/app/settings' && method === 'POST') return handleSettingsSave(req, res, user);
      if (path === '/app/delete' && method === 'POST') return handleDelete(req, res, user);
    }
    return send(res, 404, html.errorPage('Not found', 'There is nothing at this address.', '/'));
  } catch (e) {
    console.error('[flowdeck]', e && e.stack);
    return send(res, 500, html.errorPage('Something went wrong', (e && e.message) || 'Unexpected error.', '/'));
  }
};
