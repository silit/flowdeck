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

const checkUrlOf = (site) => checks.checkUrlOf(site);
const wf = require('./webflow');

// Each run stops starting new work after this long, well inside the 60-second function limit.
// Sites checked longest ago go first, so anything left over is first in line next time.
const BUDGET_MS = 40000;
let emailIndexChecked = false; // once per warm instance is enough

async function runChecks(now) {
  now = now || Date.now();
  const started = Date.now();
  if (!(await store.lock('checks', 240))) return { skipped: 'locked' };
  try {
    if (!emailIndexChecked) {
      try { await store.ensureEmailIndex(); emailIndexChecked = true; } catch (e) { console.error('[email index]', e.message); }
    }
    const ids = await store.allSiteIds();
    const sites = (await store.getSites(ids)).sort((a, b) => ((a.status && a.status.lastCheckAt) || 0) - ((b.status && b.status.lastCheckAt) || 0));
    const users = {};
    const results = await mapLimit(sites, 8, async (site) => {
      if (Date.now() - started > BUDGET_MS) return { id: site.id, skipped: 'time' };
      const url = checkUrlOf(site);
      if (!url) return { id: site.id, skipped: 'no url' };
      const c = await checks.httpCheck(url, 10000, checks.siteHosts(site));
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
      checks.addDaily(st, c);
      await store.pushCheck(site.id, { t: c.t, ok: c.ok, code: c.code, ms: c.ms });
      // Write only the status onto the latest record (the user may have changed the site meanwhile)
      const fresh = await store.saveSiteStatus(site.id, st);
      if (!fresh) return { id: site.id, skipped: 'removed' };
      if (!users[site.userId]) users[site.userId] = await store.getUser(site.userId);
      const fired = fresh.monitored ? await alerts.process(fresh, users[site.userId], now) : [];
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
    const started = Date.now();
    for (const site of sites) {
      if (Date.now() - started > BUDGET_MS) break;
      const user = await store.getUser(site.userId);
      const conn = user && user.connections.find((c) => c.id === site.connectionId);
      const token = conn && store.tokenOf(conn);
      if (!token) {
        // Move it to the back of the queue so sites without access never block the others.
        // (saveSiteSync does nothing if the site was removed earlier in this run.)
        site.syncedAt = now;
        site.syncError = 'No Webflow access for this site. Connect Webflow again in Settings.';
        const kept = await store.saveSiteSync(site);
        results.push({ id: site.id, error: kept ? 'no token' : 'removed' });
        continue;
      }
      const before = site.data && site.data.forms ? site.data.forms : null;
      try {
        await syncSite(site, token);
      } catch (e) {
        if (!wf.isRevoked(e)) {
          site.syncedAt = now;
          site.syncError = 'sync: ' + e.message;
          await store.saveSiteSync(site);
          results.push({ id: site.id, error: e.message });
          continue;
        }
        // App uninstalled or access revoked in Webflow: after a second 401 at least 10 minutes later,
        // delete the token and its sites and stop calling the API.
        const removed = await store.confirmRevoked(user, site.connectionId, now);
        if (removed) {
          const n = removed._sites.length;
          user.notice = `Webflow access for ${removed.label || 'one connection'} was removed (the app was uninstalled or access was revoked in Webflow). Flowdeck deleted the stored token and its ${n} site${n === 1 ? '' : 's'}. Connect again to bring them back.`;
          await store.saveUser(user);
          results.push({ id: site.id, revoked: true });
        } else {
          // Keep its place at the front of the queue so the next run confirms it.
          site.syncError = 'Webflow refused access. Checking again shortly.';
          await store.saveSiteSync(site);
          results.push({ id: site.id, revokedPending: true });
        }
        continue;
      }
      if (store.clearRevoked(user, site.connectionId)) await store.saveUser(user);
      // Remember the previous 30-day count so the "forms went silent" rule has a baseline.
      if (site.data && site.data.forms) {
        site.data.forms.before30 = before ? Math.max(before.total30 || 0, before.before30 || 0) : 0;
      }
      const saved = await store.saveSiteSync(site);
      if (!saved) { results.push({ id: site.id, error: 'removed' }); continue; }
      if (saved.monitored) await alerts.process(saved, user, now);
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

// Progress is kept per user and per week, so a timeout or an error never skips anyone: a later run
// on Monday, or the catch-up run on Tuesday, continues where it stopped (the cron can run hourly).
async function runDigest(now, force) {
  now = now || Date.now();
  const d = new Date(now);
  const wd = d.getUTCDay();
  if (!force && wd !== 1 && wd !== 2) return { skipped: 'not monday' };
  const monday = new Date(now - ((wd + 6) % 7) * DAY);
  const day = monday.toISOString().slice(0, 10); // the week's Monday
  if (!(await store.lock('digest', 300))) return { skipped: 'locked' };
  const started = Date.now();
  let sent = 0, pending = 0, failed = 0;
  try {
    for (const uid of await store.allUserIds()) {
      if (Date.now() - started > BUDGET_MS) { pending++; continue; }
      if (await store.digestDone(day, uid)) continue;
      const user = await store.getUser(uid);
      const to = user ? (user.settings.alertEmail || user.email || '').trim() : '';
      const sites = user && user.settings.digest !== false && to ? (await store.getSites(user.siteIds || [])).filter((s) => s.monitored) : [];
      if (!sites.length) { await store.markDigestDone(day, uid); continue; }
      for (const s of sites) s._checks = await store.recentChecks(s.id);
      try {
        await email.send({ to, subject: `[Flowdeck] Weekly report: ${sites.length} site${sites.length === 1 ? '' : 's'}`, html: digestHtml(user, sites, now), text: sites.map((s) => s.name + ': ' + (s.status && s.status.up === false ? 'DOWN' : 'ok')).join('\n') });
        await store.markDigestDone(day, uid);
        sent++;
      } catch (e) { failed++; console.error('[digest]', e.message); }
    }
  } finally {
    await store.unlock('digest');
  }
  return { sent, pending, failed };
}

function appUrl() { return (process.env.APP_URL || '').replace(/\/+$/, ''); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

module.exports = { runChecks, runSync, runDigest, digestHtml, mapLimit };
