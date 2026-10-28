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
const kv = require('./kv');
const { seal, open, random } = require('./crypto');

const PLAN_LIMITS = { free: 1, solo: 5, studio: 15, agency: 40 };
const CMS_LIMITS = { basic: 0, cms: 2000, business: 10000, enterprise: 100000, unknown: 0 };
const UPTIME_KEEP = 2016; // 7 days at 5 minute checks

// Site limit for a user: plan limit (FREE_SITE_LIMIT env can change the free one), a manual
// limitOverride set by us, or the Agency limit for emails in COMPLIMENTARY_EMAILS.
function limitFor(user) {
  const free = parseInt(process.env.FREE_SITE_LIMIT || '', 10) || PLAN_LIMITS.free;
  const base = user.plan && user.plan !== 'free' && PLAN_LIMITS[user.plan] ? PLAN_LIMITS[user.plan] : free;
  const extra = user.limitOverride > base ? user.limitOverride : base;
  const comp = String(process.env.COMPLIMENTARY_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  return comp.includes(String(user.email || '').toLowerCase()) ? Math.max(extra, PLAN_LIMITS.agency) : extra;
}

async function getUser(id) { return kv.getJSON('user:' + id); }
async function saveUser(user) {
  user.updatedAt = Date.now();
  const copy = Object.assign({}, user);
  delete copy._limit;
  await kv.setJSON('user:' + user.id, copy);
  await kv.sadd('users:all', user.id);
  return user;
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
  const o = open(conn.tokenEnc);
  return o ? o.t : null;
}

async function getSite(id) { return kv.getJSON('site:' + id); }
async function getSites(ids) { return (await kv.mgetJSON(ids.map((id) => 'site:' + id))).filter(Boolean); }
async function saveSite(site) {
  site.updatedAt = Date.now();
  await kv.setJSON('site:' + site.id, site);
  if (site.monitored) await kv.sadd('sites:all', site.id); else await kv.srem('sites:all', site.id);
  return site;
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

async function pushCheck(siteId, check) { return kv.lpushJSON('uptime:' + siteId, check, UPTIME_KEEP); }
async function recentChecks(siteId, count) { return kv.lrangeJSON('uptime:' + siteId, count || UPTIME_KEEP); }

async function getAlert(siteId, type) { return kv.getJSON(`alert:${siteId}:${type}`); }
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

async function deleteUser(id) {
  await kv.del('user:' + id);
  await kv.srem('users:all', id);
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

async function lock(name, ttl) { return kv.setNX('lock:' + name, { at: Date.now() }, ttl || 240); }
async function unlock(name) { return kv.del('lock:' + name); }

module.exports = {
  PLAN_LIMITS, CMS_LIMITS, UPTIME_KEEP, limitFor,
  getUser, saveUser, allUserIds, newUser, addConnection, tokenOf,
  getSite, getSites, saveSite, allSiteIds, deleteSite, newSite, refreshMeta, primaryUrl,
  pushCheck, recentChecks, getAlert, setAlert, clearAlert, ensureReportToken, siteIdForReport, deleteReport, deleteUser, enforceLimit, lock, unlock
};
