'use strict';
// Scheduled work. Triggered by an external cron hitting /cron/* with CRON_SECRET.
//   checks  every 5 minutes: HTTP check for every monitored site, SSL hourly, alert evaluation
//   sync    every 15 minutes: refresh Webflow data for the sites that were synced longest ago
//   digest  daily: on Monday send the weekly summary to every user who wants it
const store = require('./store');
const checks = require('./checks');
const alerts = require('./alerts');
const email = require('./email');
const { syncSite, unpublishedDays, DAY } = require('./sync');

const HOUR = 3600000;

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = { error: e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}

function checkUrlOf(site) {
  return (site.settings && site.settings.checkUrl) || site.url;
}

async function runChecks(now) {
  now = now || Date.now();
  if (!(await store.lock('checks', 240))) return { skipped: 'locked' };
  try {
    const ids = await store.allSiteIds();
    const sites = await store.getSites(ids);
    const users = {};
    const results = await mapLimit(sites, 8, async (site) => {
      const url = checkUrlOf(site);
      if (!url) return { id: site.id, skipped: 'no url' };
      const c = await checks.httpCheck(url, 10000);
      const st = site.status || {};
      st.lastCheckAt = c.t;
      st.code = c.code;
      st.ms = c.ms;
      st.error = c.error || '';
      if (c.ok) {
        if (st.up !== true) st.since = c.t;
        st.up = true;
        st.fails = 0;
      } else {
        st.fails = (st.fails || 0) + 1;
        if (st.fails >= 2 && st.up !== false) { st.up = false; st.since = c.t; }
      }
      if (url.startsWith('https://') && (!st.sslCheckedAt || now - st.sslCheckedAt > HOUR)) {
        const host = checks.hostOf(url);
        if (host) {
          const s = await checks.sslCheck(host, 8000);
          st.sslCheckedAt = now;
          st.sslExpiresAt = s.expiresAt;
          st.sslError = s.error || '';
        }
      }
      site.status = st;
      await store.pushCheck(site.id, { t: c.t, ok: c.ok, code: c.code, ms: c.ms });
      await store.saveSite(site);
      if (!users[site.userId]) users[site.userId] = await store.getUser(site.userId);
      const fired = await alerts.process(site, users[site.userId], now);
      return { id: site.id, ok: c.ok, code: c.code, ms: c.ms, alerts: fired };
    });
    return { checked: results.length, results };
  } finally {
    await store.unlock('checks');
  }
}

async function runSync(now, batch) {
  now = now || Date.now();
  if (!(await store.lock('sync', 600))) return { skipped: 'locked' };
  try {
    const ids = await store.allSiteIds();
    const sites = (await store.getSites(ids)).sort((a, b) => (a.syncedAt || 0) - (b.syncedAt || 0)).slice(0, batch || 8);
    const results = [];
    for (const site of sites) {
      const user = await store.getUser(site.userId);
      const conn = user && user.connections.find((c) => c.id === site.connectionId);
      const token = conn && store.tokenOf(conn);
      if (!token) { results.push({ id: site.id, error: 'no token' }); continue; }
      const before = site.data && site.data.forms ? site.data.forms : null;
      await syncSite(site, token);
      // Remember the previous 30-day count so the "forms went silent" rule has a baseline.
      if (site.data && site.data.forms) {
        site.data.forms.before30 = before ? Math.max(before.total30 || 0, before.before30 || 0) : 0;
      }
      await store.saveSite(site);
      await alerts.process(site, user, now);
      results.push({ id: site.id, errors: site.data ? site.data.errors : [] });
    }
    return { synced: results.length, results };
  } finally {
    await store.unlock('sync');
  }
}

function digestHtml(user, sites, now) {
  const rows = sites.map((s) => {
    const up7 = checks.summarize(s._checks || [], now - 7 * DAY);
    const ud = unpublishedDays(s, now);
    const seo = s.data && s.data.pages ? s.data.pages.issues : null;
    const forms = s.data && s.data.forms ? s.data.forms : null;
    const flags = [];
    if (s.status && s.status.up === false) flags.push('DOWN');
    if (ud != null && ud >= 7) flags.push(`unpublished ${ud}d`);
    if (s.status && s.status.sslExpiresAt && (s.status.sslExpiresAt - now) / DAY <= 14) flags.push('SSL expiring');
    return `<tr><td><strong>${esc(s.settings.client || s.name)}</strong><br><span style="color:#5d6f67;font-size:12px">${esc(s.url)}</span></td>
<td>${up7.uptime == null ? '-' : up7.uptime + '%'}</td><td>${forms ? forms.total7 : '-'}</td><td>${forms ? forms.total30 : '-'}</td><td>${seo == null ? '-' : seo}</td><td>${flags.length ? esc(flags.join(', ')) : 'OK'}</td></tr>`;
  }).join('');
  return `<div style="font-family:Figtree,Segoe UI,Helvetica,Arial,sans-serif;color:#14211b">
<h2 style="margin:0 0 6px">Weekly site report</h2><p style="margin:0 0 16px;color:#5d6f67">${sites.length} site${sites.length === 1 ? '' : 's'} · week ending ${new Date(now).toUTCString().slice(0, 16)}</p>
<table cellpadding="8" style="border-collapse:collapse;font-size:14px;width:100%"><thead><tr style="text-align:left;color:#5d6f67;font-size:12px;text-transform:uppercase"><th>Site</th><th>Uptime 7d</th><th>Forms 7d</th><th>Forms 30d</th><th>SEO issues</th><th>Flags</th></tr></thead><tbody>${rows}</tbody></table>
<p style="margin-top:18px"><a href="${appUrl()}/app">Open Flowdeck</a></p></div>`;
}

async function runDigest(now, force) {
  now = now || Date.now();
  const d = new Date(now);
  if (!force && d.getUTCDay() !== 1) return { skipped: 'not monday' };
  if (!(await store.lock('digest:' + d.toISOString().slice(0, 10), 86400))) return { skipped: 'already sent today' };
  const userIds = await store.allUserIds();
  let sent = 0;
  for (const uid of userIds) {
    const user = await store.getUser(uid);
    if (!user || user.settings.digest === false) continue;
    const to = (user.settings.alertEmail || user.email || '').trim();
    if (!to) continue;
    const sites = (await store.getSites(user.siteIds || [])).filter((s) => s.monitored);
    if (!sites.length) continue;
    for (const s of sites) s._checks = await store.recentChecks(s.id);
    try {
      await email.send({ to, subject: `[Flowdeck] Weekly report: ${sites.length} site${sites.length === 1 ? '' : 's'}`, html: digestHtml(user, sites, now), text: sites.map((s) => s.name + ': ' + (s.status && s.status.up === false ? 'DOWN' : 'ok')).join('\n') });
      sent++;
    } catch (e) { console.error('[digest]', e.message); }
  }
  return { sent };
}

function appUrl() { return (process.env.APP_URL || '').replace(/\/+$/, ''); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

module.exports = { runChecks, runSync, runDigest, digestHtml, mapLimit };
