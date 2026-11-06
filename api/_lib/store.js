'use strict';
// Data access on top of kv. Keys:
//   user:{id}            user record (connections hold encrypted tokens)
//   users:all            set of user ids
//   site:{id}            site record (metadata, synced data, status, settings)
//   sites:all            set of monitored site ids
//   uptime:{siteId}      list of recent checks, newest first
//   alert:{siteId}:{t}   open alert state
//   report:{token}       siteId for public report links
//   lock:{name}          cron locks
//   email:{address}      user id for an email (sign in by email link)
//   login:{sha256}       one-time sign in link, 15 minutes
const kv = require('./kv');
const { seal, open, random, sha256 } = require('./crypto');

const PLAN_LIMITS = { free: 1, solo: 5, studio: 15, agency: 40 };
const CMS_LIMITS = { basic: 0, cms: 2000, business: 10000, enterprise: 100000, unknown: 0 };
const UPTIME_KEEP = 2016; // 7 days at 5 minute checks

// Site limit for a user: plan limit (FREE_SITE_LIMIT env can change the free one), a manual
// limitOverride set by us, or the Agency limit for emails in COMPLIMENTARY_EMAILS.
function limitFor(user) {
  const free = parseInt(process.env.FREE_SITE_LIMIT || '', 10) || PLAN_LIMITS.free;
  const base = user.plan && user.plan !== 'free' && PLAN_LIMITS[user.plan] ? PLAN_LIMITS[user.plan] : free;
  const extra = user.limitOverride > base ? user.limitOverride : base;
  // "@webflow.com" is always included so the Marketplace review team gets the highest tier (Agency).
  const comp = ['@webflow.com'].concat(String(process.env.COMPLIMENTARY_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean));
  const email = String(user.email || '').toLowerCase();
  // entries starting with "@" match a whole domain, e.g. "@webflow.com" for the Marketplace review team
  const isFree = comp.some((e) => (e.startsWith('@') ? email.endsWith(e) : email === e));
  return isFree ? Math.max(extra, PLAN_LIMITS.agency) : extra;
}

async function getUser(id) { return kv.getJSON('user:' + id); }
async function saveUser(user) {
  user.updatedAt = Date.now();
  const copy = Object.assign({}, user);
  delete copy._limit;
  await kv.setJSON('user:' + user.id, copy);
  await kv.sadd('users:all', user.id);
  if (user.email) await kv.setJSON('email:' + String(user.email).toLowerCase(), { u: user.id });
  return user;
}

// Returning users sign in with a one-time email link; Webflow OAuth runs only to install or add sites.
async function findUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  const idx = await kv.getJSON('email:' + e);
  if (idx && idx.u) {
    const u = await getUser(idx.u);
    if (u && String(u.email || '').toLowerCase() === e) return u;
  }
  // No scan of all users here: an unknown address must cost the same few reads as a known one.
  // ensureEmailIndex() fills the index once for accounts created before it existed.
  return null;
}
async function ensureEmailIndex() {
  if (await kv.getJSON('migr:email-index')) return 0; // done before
  if (!(await kv.setNX('migr:email-index:run', { at: Date.now() }, 120))) return 0; // another run is on it
  try {
    let n = 0;
    for (const id of await allUserIds()) {
      const u = await getUser(id);
      if (u && u.email) { await kv.setJSON('email:' + String(u.email).toLowerCase(), { u: u.id }); n++; }
    }
    await kv.setJSON('migr:email-index', { at: Date.now(), n }); // only marked done once it finished
    return n;
  } finally {
    await kv.del('migr:email-index:run');
  }
}
async function createLoginToken(userId) {
  const t = random(24);
  await kv.setJSON('login:' + sha256(t), { u: userId, at: Date.now() }, 900);
  return t;
}
async function peekLoginToken(t) { return t ? kv.getJSON('login:' + sha256(t)) : null; }
async function consumeLoginToken(t) {
  if (!t) return null;
  // GETDEL reads and deletes in one step, so two requests at once cannot both use the link
  return kv.getDelJSON('login:' + sha256(t));
}
async function loginRateOk(email) { return kv.setNX('loginrl:' + String(email).toLowerCase(), { at: Date.now() }, 60); }
// Counter-based limit: at most `max` hits per `windowSec` for a key (an IP address, or "all").
async function rateOk(key, max, windowSec) {
  const n = await kv.incr('rl:' + key);
  if (n === 1) await kv.expire('rl:' + key, windowSec);
  return n <= max;
}
async function allUserIds() { return kv.smembers('users:all'); }

function newUser(info) {
  return {
    id: info.id,
    email: info.email || '',
    name: [info.firstName, info.lastName].filter(Boolean).join(' '),
    plan: 'free',
    createdAt: Date.now(),
    settings: { digest: true, alerts: true, brand: '', alertEmail: info.email || '' },
    connections: [],
    siteIds: []
  };
}

function addConnection(user, token, label) {
  const conn = { id: random(8), tokenEnc: seal({ t: token }), label: label || '', authorizedAt: Date.now() };
  user.connections.push(conn);
  return conn;
}
function tokenOf(conn) {
  if (!conn || !conn.tokenEnc) return null;
  const o = open(conn.tokenEnc);
  return o ? o.t : null;
}

// Removes a Webflow connection and every site that came with it. Used when the user disconnects,
// when Webflow reports the authorization was revoked (app uninstalled), and when a new
// authorization replaces an old one. Returns the removed connection (with its token) or null.
async function removeConnection(user, connId) {
  const conn = (user.connections || []).find((c) => c.id === connId);
  if (!conn) return null;
  user.connections = user.connections.filter((c) => c.id !== connId);
  const sites = await getSites(user.siteIds || []);
  const gone = sites.filter((s) => s.connectionId === connId);
  for (const site of gone) {
    if (site.settings && site.settings.reportToken) await deleteReport(site.settings.reportToken);
    await kv.del(...['down', 'ssl', 'unpublished', 'forms_silent'].map((t) => `alert:${site.id}:${t}`));
    await deleteSite(site.id);
  }
  user.siteIds = (user.siteIds || []).filter((id) => !gone.some((s) => s.id === id));
  conn._sites = gone.map((s) => s.name);
  return conn;
}

async function getSite(id) { return kv.getJSON('site:' + id); }
async function getSites(ids) { return (await kv.mgetJSON(ids.map((id) => 'site:' + id))).filter(Boolean); }
async function saveSite(site) {
  site.updatedAt = Date.now();
  await kv.setJSON('site:' + site.id, site);
  if (site.monitored) await kv.sadd('sites:all', site.id); else await kv.srem('sites:all', site.id);
  return site;
}
// The checks job only owns site.status. It re-reads the record and writes status onto the latest
// version, so a pause, a new report link or a settings change made during the run is never lost.
// Returns null when the site was removed meanwhile.
async function saveSiteStatus(siteId, status) {
  const fresh = await getSite(siteId);
  if (!fresh) return null;
  fresh.status = status;
  fresh.updatedAt = Date.now();
  await kv.setJSON('site:' + siteId, fresh);
  return fresh;
}
// The sync job owns the Webflow data and metadata fields; same merge onto the latest record.
const SYNC_FIELDS = ['name', 'shortName', 'domains', 'url', 'previewUrl', 'lastPublished', 'lastUpdated', 'data', 'syncedAt', 'syncError'];
async function saveSiteSync(site) {
  const fresh = await getSite(site.id);
  if (!fresh) return null;
  for (const k of SYNC_FIELDS) if (site[k] !== undefined) fresh[k] = site[k];
  return saveSite(fresh);
}
async function allSiteIds() { return kv.smembers('sites:all'); }
async function deleteSite(id) {
  await kv.del('site:' + id, 'uptime:' + id);
  await kv.srem('sites:all', id);
}

function primaryUrl(meta) {
  const domains = (meta.customDomains || []).map((d) => d.url).filter(Boolean);
  const host = domains[0] || (meta.shortName ? meta.shortName + '.webflow.io' : '');
  const scheme = process.env.SITE_URL_SCHEME || 'https';
  return host ? scheme + '://' + host : '';
}

function newSite(meta, userId, connectionId) {
  return {
    id: meta.id,
    userId,
    connectionId,
    name: meta.displayName || meta.shortName || meta.id,
    shortName: meta.shortName || '',
    workspaceId: meta.workspaceId || '',
    domains: (meta.customDomains || []).map((d) => d.url).filter(Boolean),
    url: primaryUrl(meta),
    previewUrl: meta.previewUrl || '',
    lastPublished: meta.lastPublished || null,
    lastUpdated: meta.lastUpdated || null,
    createdAt: Date.now(),
    monitored: true,
    settings: { plan: 'unknown', client: '', alerts: true, checkUrl: '', reportToken: '' },
    data: null,
    status: { up: null, since: null, lastCheckAt: null, code: null, ms: null, fails: 0, sslExpiresAt: null, sslCheckedAt: null, sslError: '' },
    syncedAt: null,
    syncError: ''
  };
}

function refreshMeta(site, meta) {
  site.name = meta.displayName || site.name;
  site.shortName = meta.shortName || site.shortName;
  site.domains = (meta.customDomains || []).map((d) => d.url).filter(Boolean);
  site.url = primaryUrl(meta) || site.url;
  site.previewUrl = meta.previewUrl || site.previewUrl;
  site.lastPublished = meta.lastPublished || site.lastPublished;
  site.lastUpdated = meta.lastUpdated || site.lastUpdated;
  return site;
}

// LPUSH every time; trim only when the list has grown 24 past the limit (one LTRIM per ~2 hours per site).
async function pushCheck(siteId, check) {
  const n = await kv.command('LPUSH', 'uptime:' + siteId, JSON.stringify(check));
  if (n > UPTIME_KEEP + 24) await kv.command('LTRIM', 'uptime:' + siteId, '0', String(UPTIME_KEEP - 1));
  return n;
}
async function recentChecks(siteId, count) { return kv.lrangeJSON('uptime:' + siteId, count || UPTIME_KEEP); }

async function getAlert(siteId, type) { return kv.getJSON(`alert:${siteId}:${type}`); }
async function getAlerts(siteId, types) {
  const vals = await kv.mgetJSON(types.map((t) => `alert:${siteId}:${t}`));
  return Object.fromEntries(types.map((t, i) => [t, vals[i] || null]));
}
// Backoff for alert emails that failed: { n: attempts, until: next try }.
async function getAlertFail(siteId, type) { return kv.getJSON(`alertfail:${siteId}:${type}`); }
async function setAlertFail(siteId, type, state) { return kv.setJSON(`alertfail:${siteId}:${type}`, state, 86400); }
async function clearAlertFail(siteId, type) { return kv.del(`alertfail:${siteId}:${type}`); }
async function setAlert(siteId, type, state) { return kv.setJSON(`alert:${siteId}:${type}`, state); }
async function clearAlert(siteId, type) { return kv.del(`alert:${siteId}:${type}`); }

async function ensureReportToken(site) {
  if (!site.settings.reportToken) {
    site.settings.reportToken = random(12);
    await kv.setJSON('report:' + site.settings.reportToken, { siteId: site.id });
    await saveSite(site);
  }
  return site.settings.reportToken;
}
async function siteIdForReport(token) {
  const r = await kv.getJSON('report:' + token);
  return r ? r.siteId : null;
}
async function deleteReport(token) { return token ? kv.del('report:' + token) : 0; }

async function deleteUser(id, email) {
  await kv.del('user:' + id);
  await kv.srem('users:all', id);
  if (email) await kv.del('email:' + String(email).toLowerCase());
}

// Keeps at most `limit` sites monitored. Sites already monitored keep their place (oldest first),
// then sites paused only because of the limit fill free slots; sites the user paused stay paused.
async function enforceLimit(user, limit) {
  const sites = await getSites(user.siteIds || []);
  const byAge = (a, b) => (a.createdAt || 0) - (b.createdAt || 0);
  const on = sites.filter((s) => s.monitored).sort(byAge);
  const waiting = sites.filter((s) => !s.monitored && !s.pausedByUser).sort(byAge);
  let changed = 0;
  for (let i = limit; i < on.length; i++) { on[i].monitored = false; await saveSite(on[i]); changed++; }
  for (let i = 0, free = limit - Math.min(on.length, limit); i < waiting.length && i < free; i++) { waiting[i].monitored = true; await saveSite(waiting[i]); changed++; }
  return changed;
}

// Webflow answered 401 for this connection. Delete it only after a second 401 at least
// REVOKE_CONFIRM_MS (default 10 minutes) later, so a short Webflow incident cannot wipe an account.
// Returns the removed connection, or null while waiting for confirmation. The caller saves the user.
async function confirmRevoked(user, connId, now) {
  now = now || Date.now();
  const conn = (user.connections || []).find((c) => c.id === connId);
  if (!conn) return null;
  const raw = process.env.REVOKE_CONFIRM_MS;
  const wait = raw != null && raw !== '' && !isNaN(parseInt(raw, 10)) ? parseInt(raw, 10) : 600000;
  if (!conn.revokedSince) {
    conn.revokedSince = now;
    if (wait > 0) { await saveUser(user); return null; }
  }
  if (now - conn.revokedSince < wait) return null;
  return removeConnection(user, connId);
}
// A successful call clears an earlier 401 strike. Returns true when the user record changed.
function clearRevoked(user, connId) {
  const conn = (user.connections || []).find((c) => c.id === connId);
  if (conn && conn.revokedSince) { delete conn.revokedSince; return true; }
  return false;
}

// Weekly digest progress per user, so a timeout or error never skips the rest for a week.
async function digestDone(day, userId) { return !!(await kv.getJSON(`digestsent:${day}:${userId}`)); }
async function markDigestDone(day, userId) { return kv.setJSON(`digestsent:${day}:${userId}`, { at: Date.now() }, 3 * 86400); }

async function lock(name, ttl) { return kv.setNX('lock:' + name, { at: Date.now() }, ttl || 240); }
async function unlock(name) { return kv.del('lock:' + name); }

module.exports = {
  PLAN_LIMITS, CMS_LIMITS, UPTIME_KEEP, limitFor,
  getUser, saveUser, allUserIds, newUser, addConnection, tokenOf, removeConnection,
  findUserByEmail, ensureEmailIndex, createLoginToken, peekLoginToken, consumeLoginToken, loginRateOk, rateOk,
  getSite, getSites, saveSite, saveSiteStatus, saveSiteSync, allSiteIds, deleteSite, newSite, refreshMeta, primaryUrl,
  pushCheck, recentChecks, getAlert, getAlerts, setAlert, clearAlert, getAlertFail, setAlertFail, clearAlertFail, ensureReportToken, siteIdForReport, deleteReport, deleteUser, enforceLimit,
  confirmRevoked, clearRevoked, digestDone, markDigestDone, lock, unlock
};
