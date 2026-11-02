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
const billing = require('./_lib/billing');
const email = require('./_lib/email');

const ENV = () => ({
  clientId: process.env.WEBFLOW_CLIENT_ID || '',
  clientSecret: process.env.WEBFLOW_CLIENT_SECRET || '',
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  cronSecret: process.env.CRON_SECRET || ''
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
function limitFor(user) { return store.limitFor(user); }

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
  if (q.error) {
    const why = q.error === 'access_denied' ? 'You cancelled on the Webflow screen, so Flowdeck has no access to your sites and nothing was stored.' : String(q.error_description || q.error);
    return send(res, 400, html.errorPage('Authorization cancelled', why + ' You can connect any time from the home page.', '/'));
  }
  if (!q.code) return send(res, 400, html.errorPage('Missing code', 'Webflow did not return an authorization code.', '/'));
  // Our /auth link always carries a state that must match the cookie set there. The Marketplace
  // install link (Webflow's recommended form) carries no state and no redirect_uri.
  const fromAuthLink = !!q.state;
  if (fromAuthLink && (!c.fd_state || !timingEqual(q.state, c.fd_state))) return send(res, 400, html.errorPage('Sign in expired', 'This sign in request did not match the one we started, or it took longer than 10 minutes. Please start again.', '/auth'));

  const started = Date.now();
  let token;
  try { token = await wf.exchangeCode({ clientId: env.clientId, clientSecret: env.clientSecret, code: q.code, redirectUri: fromAuthLink ? env.appUrl + '/callback' : null }); }
  catch (e) {
    console.error('[flowdeck] token exchange failed', fromAuthLink ? 'auth-link' : 'install-link', e.status || '', e.message);
    return send(res, 400, html.errorPage('Could not connect to Webflow', 'Webflow did not accept the authorization (' + e.message + '). Please start again.', '/auth'));
  }

  let info;
  try { info = await wf.authorizedBy(token); } catch (e) {
    console.error('[flowdeck] authorized_by failed', e.status || '', e.message);
    return send(res, 400, html.errorPage('Could not read your Webflow user', e.message, '/'));
  }
  if (!info || !info.id) return send(res, 400, html.errorPage('Could not read your Webflow user', 'Webflow returned no user id.', '/'));

  let user = await store.getUser(info.id);
  if (!user) user = store.newUser(info);
  user.email = info.email || user.email;
  const conn = store.addConnection(user, token, info.email || '');

  let sitesMeta = [];
  try { sitesMeta = await wf.listSites(token); } catch (e) { console.error('[flowdeck] list sites failed', e.status || '', e.message); sitesMeta = []; }
  const limit = limitFor(user);
  const notices = [];
  let added = 0;
  for (const meta of sitesMeta) {
    const existing = await store.getSite(meta.id);
    if (existing && existing.userId !== user.id) { notices.push(`${meta.displayName || meta.id} is already connected by another account.`); continue; }
    let site = existing || store.newSite(meta, user.id, conn.id);
    if (existing) { store.refreshMeta(site, meta); site.connectionId = conn.id; }
    else site.monitored = false; // enforceLimit below decides
    await store.saveSite(site);
    if (!user.siteIds.includes(site.id)) { user.siteIds.push(site.id); added++; }
  }
  // A new authorization can replace an older one for the same sites: drop connections left with no sites.
  for (const old of user.connections.filter((x) => x.id !== conn.id)) {
    const still = (await store.getSites(user.siteIds)).some((s) => s.connectionId === old.id);
    if (!still) {
      const removed = await store.removeConnection(user, old.id);
      if (removed) await wf.revokeToken({ clientId: env.clientId, clientSecret: env.clientSecret, token: store.tokenOf(removed) });
    }
  }
  await store.saveUser(user);
  await store.enforceLimit(user, limit);

  // First data for a few sites right away, so the dashboard is not empty. Kept inside a short
  // time budget so a workspace with many or large sites never makes the sign in time out;
  // the sync job fills in the rest within minutes.
  const BUDGET_MS = 12000;
  const fresh = (await store.getSites(user.siteIds)).filter((s) => s.monitored && !s.syncedAt).slice(0, 3);
  for (const site of fresh) {
    if (Date.now() - started > BUDGET_MS) break;
    try {
      await syncSite(site, token, { pages: 100, collections: 10, submissions: 100 });
      const url = checks.checkUrlOf(site);
      if (url && Date.now() - started < BUDGET_MS) {
        const chk = await checks.httpCheck(url, 5000);
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
  await store.enforceLimit(user, user._limit);
  const sites = await store.getSites(user.siteIds || []);
  const checksBySite = {};
  for (const s of sites) checksBySite[s.id] = await store.recentChecks(s.id);
  let notice = q.notice ? html.esc(q.notice) : '';
  if (q.added) notice = `${html.esc(q.added)} site${q.added === '1' ? '' : 's'} connected. First data is loading; uptime starts within 5 minutes.`;
  if (q.synced) notice = 'Data refreshed from Webflow.';
  // A one-time message from the server (for example: access was revoked in Webflow) wins.
  if (user.notice) { notice = html.esc(user.notice); delete user.notice; await store.saveUser(user); }
  send(res, 200, html.dashboard(user, sites, checksBySite, Date.now(), notice));
}

async function handleSync(req, res, user) {
  const b = await readBody(req);
  const one = b.id ? await ownedSite(user, String(b.id)) : null;
  const sites = one ? [one] : (await store.getSites(user.siteIds || [])).filter((s) => s.monitored).sort((a, b) => (a.syncedAt || 0) - (b.syncedAt || 0)).slice(0, 10);
  for (const site of sites) {
    const conn = user.connections.find((c) => c.id === site.connectionId);
    const token = conn && store.tokenOf(conn);
    if (!token) continue;
    const before = site.data && site.data.forms ? site.data.forms : null;
    try {
      await syncSite(site, token, { pages: 300, collections: 20, submissions: 300 });
      if (site.data && site.data.forms) site.data.forms.before30 = before ? Math.max(before.total30 || 0, before.before30 || 0) : 0;
      await store.saveSite(site);
    } catch (e) {
      if (wf.isRevoked(e)) {
        const removed = await store.removeConnection(user, site.connectionId);
        if (removed) user.notice = revokedNotice(removed);
        await store.saveUser(user);
      }
    }
  }
  if (one && (user.siteIds || []).includes(one.id)) return redirect(res, '/app/site?id=' + encodeURIComponent(one.id) + '&synced=1');
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
  const notice = q.full ? `Your plan monitors up to ${user._limit} site${user._limit === 1 ? '' : 's'}. Pause another site or <a href="/app/settings#plan">upgrade</a>.` : (q.saved ? 'Settings saved.' : (q.synced ? 'Data refreshed from Webflow.' : ''));
  send(res, 200, html.siteDetail(user, site, recent, Date.now(), notice));
}

async function handleSiteSettings(req, res, user) {
  const b = await readBody(req);
  const site = await ownedSite(user, b.id);
  if (!site) return send(res, 404, html.errorPage('Site not found', 'That site is not connected to your account.'));
  site.settings.client = String(b.client || '').trim().slice(0, 80);
  site.settings.plan = ['unknown', 'basic', 'cms', 'business', 'enterprise'].includes(b.plan) ? b.plan : 'unknown';
  const url = String(b.checkUrl || '').trim();
  if (url && !checks.allowedCheckUrl(site, url)) {
    return send(res, 400, html.errorPage('URL not allowed', 'The URL to check must be an https address on one of this site\'s own domains: ' + checks.siteHosts(site).join(', ') + '.', '/app/site?id=' + encodeURIComponent(site.id)));
  }
  site.settings.checkUrl = url;
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

async function handleSiteMonitor(req, res, user) {
  const b = await readBody(req);
  const site = await ownedSite(user, b.id);
  if (!site) return send(res, 404, html.errorPage('Site not found', 'That site is not connected to your account.'));
  const on = b.on === '1';
  if (on && !site.monitored) {
    const count = (await store.getSites(user.siteIds || [])).filter((s) => s.monitored).length;
    if (count >= user._limit) return redirect(res, '/app/site?id=' + encodeURIComponent(site.id) + '&full=1');
  }
  site.monitored = on;
  site.pausedByUser = !on;
  await store.saveSite(site);
  redirect(res, '/app/site?id=' + encodeURIComponent(site.id) + '&saved=1');
}

async function handleCheckout(req, res, user) {
  const b = await readBody(req);
  if (!billing.enabled()) return send(res, 503, html.errorPage('Upgrades are not open yet', 'Write to info@silitlabs.com and we will raise your limit.', '/app/settings'));
  try {
    const url = await billing.checkoutUrl(user, String(b.plan || ''), String(b.interval || ''), ENV().appUrl);
    redirect(res, url);
  } catch (e) {
    console.error('[billing]', e.message);
    send(res, 502, html.errorPage('Could not open checkout', e.message, '/app/settings'));
  }
}

async function handlePortal(req, res, user) {
  const url = await billing.portalUrl(user);
  if (!url) return redirect(res, '/app/settings#plan');
  redirect(res, url);
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
  const notice = q.upgraded ? 'Thanks! Your plan updates as soon as the payment is confirmed, usually within a minute.' : (q.saved ? 'Settings saved.' : (q.notice ? html.esc(q.notice) : ''));
  send(res, 200, html.settings(user, sites, notice, { billing: billing.enabled() }));
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
  const env = ENV();
  for (const c of user.connections || []) await wf.revokeToken({ clientId: env.clientId, clientSecret: env.clientSecret, token: store.tokenOf(c) });
  for (const id of user.siteIds || []) {
    const site = await store.getSite(id);
    if (site && site.userId === user.id) {
      if (site.settings.reportToken) await store.deleteReport(site.settings.reportToken);
      for (const t of Object.keys(alerts.RULES)) await store.clearAlert(site.id, t);
      await store.deleteSite(site.id);
    }
  }
  await store.deleteUser(user.id, user.email);
  res.setHeader('Set-Cookie', [cookie('fd_session', '', 0)]);
  redirect(res, '/?deleted=1');
}

function revokedNotice(conn) {
  const n = (conn._sites || []).length;
  return `Webflow access for ${conn.label || 'one connection'} was removed (the app was uninstalled or access was revoked in Webflow). Flowdeck deleted the stored token and its ${n} site${n === 1 ? '' : 's'}. Connect again to bring them back.`;
}

async function handleDisconnect(req, res, user) {
  const env = ENV();
  const b = await readBody(req);
  const removed = await store.removeConnection(user, String(b.id || ''));
  if (!removed) return send(res, 404, html.errorPage('Connection not found', 'That Webflow connection is not on your account.', '/app/settings'));
  await wf.revokeToken({ clientId: env.clientId, clientSecret: env.clientSecret, token: store.tokenOf(removed) });
  await store.saveUser(user);
  const n = removed._sites.length;
  redirect(res, '/app/settings?notice=' + encodeURIComponent(`Disconnected ${removed.label || 'Webflow'}: access revoked, token and ${n} site${n === 1 ? '' : 's'} deleted.`));
}

/* ---------- sign in by email link (returning users) ---------- */

async function handleLoginPage(req, res) {
  if (await currentUser(req)) return redirect(res, '/app');
  send(res, 200, html.loginPage(queryOf(req)));
}

async function handleLoginPost(req, res) {
  const b = await readBody(req);
  const addr = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return redirect(res, '/login?bad=1');
  if (await store.loginRateOk(addr)) {
    const user = await store.findUserByEmail(addr);
    if (user) {
      const t = await store.createLoginToken(user.id);
      const link = ENV().appUrl + '/l/' + t;
      try {
        await email.send({ to: user.email, subject: 'Your Flowdeck sign in link',
          html: `<div style="font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#121a24"><p>Click to sign in to Flowdeck. The link works once and expires in 15 minutes.</p><p><a href="${html.esc(link)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Sign in to Flowdeck</a></p><p style="color:#5b6876;font-size:13px">If you did not ask for this, ignore this email.</p></div>`,
          text: 'Sign in to Flowdeck (works once, expires in 15 minutes): ' + link });
      } catch (e) { console.error('[flowdeck] login email failed', e.message); }
    }
  }
  // Same answer whether or not an account exists, so addresses cannot be probed.
  redirect(res, '/login?sent=1');
}

async function handleLoginLink(req, res, token, method) {
  if (method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, html.errorPage('Blocked', 'Cross-site request blocked.', '/login'));
    const rec = await store.consumeLoginToken(token);
    const user = rec && (await store.getUser(rec.u));
    if (!user) return send(res, 400, html.errorPage('Link expired', 'This sign in link was already used or is older than 15 minutes. Ask for a new one.', '/login'));
    res.setHeader('Set-Cookie', [sessionCookie(user.id)]);
    return redirect(res, '/app');
  }
  // GET only shows a button, so link scanners in mail apps cannot use up the link.
  const rec = await store.peekLoginToken(token);
  if (!rec) return send(res, 400, html.errorPage('Link expired', 'This sign in link was already used or is older than 15 minutes. Ask for a new one.', '/login'));
  send(res, 200, html.loginConfirm(token));
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
    if (path === '/auth') return await handleAuth(req, res);
    if (path === '/login' && method === 'POST') return await handleLoginPost(req, res);
    if (path === '/login') return await handleLoginPage(req, res);
    if (path.startsWith('/l/')) return await handleLoginLink(req, res, path.slice(3), method);
    if (path === '/callback') return await handleCallback(req, res);
    if (path === '/logout') { res.setHeader('Set-Cookie', [cookie('fd_session', '', 0)]); return redirect(res, '/'); }
    if (path.startsWith('/r/')) return await handleReport(req, res, path.slice(3));

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
      if (!user) return redirect(res, '/login');
      if (method === 'POST' && !sameOrigin(req)) return send(res, 403, html.errorPage('Blocked', 'Cross-site request blocked.'));
      if (path === '/app' && method === 'GET') return await handleApp(req, res, user);
      if (path === '/app/sync' && method === 'POST') return await handleSync(req, res, user);
      if (path === '/app/site' && method === 'GET') return await handleSitePage(req, res, user);
      if (path === '/app/site/settings' && method === 'POST') return await handleSiteSettings(req, res, user);
      if (path === '/app/site/report' && method === 'POST') return await handleSiteReport(req, res, user);
      if (path === '/app/site/remove' && method === 'POST') return await handleSiteRemove(req, res, user);
      if (path === '/app/site/monitor' && method === 'POST') return await handleSiteMonitor(req, res, user);
      if (path === '/app/billing/checkout' && method === 'POST') return await handleCheckout(req, res, user);
      if (path === '/app/billing/portal' && method === 'GET') return await handlePortal(req, res, user);
      if (path === '/app/settings' && method === 'GET') return await handleSettingsPage(req, res, user);
      if (path === '/app/settings' && method === 'POST') return await handleSettingsSave(req, res, user);
      if (path === '/app/delete' && method === 'POST') return await handleDelete(req, res, user);
      if (path === '/app/connection/remove' && method === 'POST') return await handleDisconnect(req, res, user);
    }
    return send(res, 404, html.errorPage('Not found', 'There is nothing at this address.', '/'));
  } catch (e) {
    console.error('[flowdeck]', e && e.stack);
    return send(res, 500, html.errorPage('Something went wrong', (e && e.message) || 'Unexpected error.', '/'));
  }
};
