'use strict';
// Server-rendered pages. No framework, one CSS block, tokens for light and dark.
const { summarize } = require('./checks');
const { unpublishedDays, DAY } = require('./sync');
const { PLAN_LIMITS, CMS_LIMITS } = require('./store');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const appUrl = () => (process.env.APP_URL || '').replace(/\/+$/, '');

function ago(ts, now) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor(((now || Date.now()) - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(typeof ts === 'string' ? Date.parse(ts) : ts);
  return isNaN(d) ? '-' : d.toISOString().slice(0, 10);
}
function days(ts, now) { return ts ? Math.floor((ts - (now || Date.now())) / DAY) : null; }

const CSS = `
:root{--bg:#f4f6f8;--surface:#fff;--fg:#121a24;--muted:#5b6876;--line:#dbe1e8;--accent:#1f6feb;--accent-ink:#fff;--ok:#1a9a5a;--ok-bg:#dff5e8;--bad:#c9372c;--bad-bg:#fde3df;--warn:#b26a00;--warn-bg:#fff0d6;--code:#eef2f6}
@media(prefers-color-scheme:dark){:root{--bg:#0f141a;--surface:#161d26;--fg:#e8edf2;--muted:#94a1af;--line:#2a3441;--accent:#5b9dff;--accent-ink:#0b1220;--ok:#49d08a;--ok-bg:#133526;--bad:#ff7b6e;--bad-bg:#40201c;--warn:#ffb55c;--warn-bg:#3c2d12;--code:#1f2832;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 Figtree,"Segoe UI",Helvetica,Arial,sans-serif;padding:0 max(16px,env(safe-area-inset-left)) 48px max(16px,env(safe-area-inset-right))}
.wrap{max-width:1180px;margin:0 auto}a{color:var(--accent)}h1,h2,h3{font-family:"Bricolage Grotesque",Arial,sans-serif;margin:0;line-height:1.15}h1{font-size:clamp(24px,3vw,32px)}h2{font-size:20px}h3{font-size:16px}p{margin:0}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 0;border-bottom:1px solid var(--line);margin-bottom:24px}.brand{font-family:"Bricolage Grotesque",Arial,sans-serif;font-weight:700;font-size:21px;text-decoration:none;color:var(--fg)}.brand span{color:var(--accent)}
.top nav{display:flex;gap:16px;font-size:14px;font-weight:500}.top nav a{color:var(--fg);text-decoration:none}.top nav a:hover{color:var(--accent)}
.head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:18px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}.stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.stat .n{font-family:"Bricolage Grotesque",Arial,sans-serif;font-size:28px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}.stat .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:6px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px;min-width:0}.panel+.panel{margin-top:16px}
.tablewrap{overflow-x:auto;background:var(--surface);border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:900px;font-size:14px}th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:middle;white-space:nowrap}th{font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}td.num{font-variant-numeric:tabular-nums}tbody tr:hover{background:var(--code)}
.pill{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:999px;padding:3px 9px}.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.off{background:var(--code);color:var(--muted)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px;vertical-align:middle}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}.dot.off{background:var(--muted)}
.muted{color:var(--muted)}.small{font-size:13px}.mono{font-family:"JetBrains Mono",Menlo,Consolas,monospace;font-size:12.5px}
.btn{font:inherit;font-weight:600;font-size:14px;border-radius:8px;padding:9px 14px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--fg);text-decoration:none;display:inline-flex;gap:8px;align-items:center}.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}.btn.danger{color:var(--bad)}.btn.sm{padding:6px 10px;font-size:13px}
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;align-items:start}
.fields{display:grid;gap:12px}.field{display:grid;gap:5px}label{font-size:13px;font-weight:600}.hint{font-size:12.5px;color:var(--muted)}
input[type=text],input[type=email],input[type=url],select{width:100%;font:inherit;font-size:14px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:9px 11px}
.check{display:flex;gap:10px;align-items:flex-start;font-size:14px;font-weight:400}.check input{margin-top:3px;accent-color:var(--accent)}
.notice{border-left:4px solid var(--accent);padding:12px 14px;background:var(--surface);border-radius:8px;margin-bottom:16px}.notice.bad{border-left-color:var(--bad)}.notice.warn{border-left-color:var(--warn)}
ul.issues{margin:6px 0 0;padding-left:18px;display:grid;gap:4px;font-size:14px}ul.issues li span{color:var(--muted)}
.bars{display:flex;gap:2px;align-items:flex-end;height:44px;margin-top:8px;width:100%;overflow:hidden}.bars i{flex:1 1 0;min-width:0;background:var(--ok);border-radius:2px}.bars i.bad{background:var(--bad)}.bars i.off{background:var(--line)}
.empty{padding:40px;text-align:center;color:var(--muted)}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:8px 20px}
@media(max-width:700px){.top nav{gap:10px;font-size:13px}}
`;

function layout(title, body, opts) {
  opts = opts || {};
  const nav = opts.user
    ? `<nav><a href="/app">Sites</a><a href="/app/settings">Settings</a><a href="/logout">Sign out</a></nav>`
    : `<nav><a href="/">Home</a><a href="/auth">Sign in with Webflow</a></nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title>
<link rel="icon" href="/favicon.png"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap">
<style>${CSS}</style></head><body><div class="wrap">
<header class="top"><a class="brand" href="${opts.user ? '/app' : '/'}">Flow<span>deck</span></a>${opts.plain ? '' : nav}</header>
${body}
<footer><span>Flowdeck</span><a href="/privacy">Privacy</a><a href="/terms">Terms</a><span>Not affiliated with Webflow.</span></footer>
</div></body></html>`;
}

function errorPage(title, message, back) {
  return layout(title, `<div class="panel notice bad"><h2>${esc(title)}</h2><p style="margin-top:8px">${esc(message)}</p><div class="actions" style="margin-top:14px"><a class="btn" href="${esc(back || '/app')}">Back</a></div></div>`);
}

function statusPill(site) {
  const st = site.status || {};
  if (st.up === true) return `<span class="pill ok">Up</span>`;
  if (st.up === false) return `<span class="pill bad">Down</span>`;
  return `<span class="pill off">Pending</span>`;
}

function publishCell(site, now) {
  const ud = unpublishedDays(site, now);
  if (ud == null) return `<span class="muted">Published ${esc(fmtDate(site.lastPublished))}</span>`;
  return `<span class="pill ${ud >= 7 ? 'warn' : 'off'}">Unpublished ${ud < 1 ? '<1d' : ud + 'd'}</span>`;
}

function sslCell(site, now) {
  const st = site.status || {};
  if (!st.sslCheckedAt) return '<span class="muted">-</span>';
  if (!st.sslExpiresAt) return `<span class="pill bad">Invalid</span>`;
  const d = days(st.sslExpiresAt, now);
  return `<span class="${d <= 14 ? 'pill warn' : 'muted'}">${d}d</span>`;
}

function cmsCell(site) {
  const cms = site.data && site.data.cms;
  if (!cms) return '<span class="muted">-</span>';
  const limit = CMS_LIMITS[site.settings.plan] || 0;
  if (!limit) return `${cms.total}`;
  const pct = Math.round((cms.total / limit) * 100);
  return `<span class="${pct >= 90 ? 'pill warn' : ''}">${cms.total} / ${limit}${pct >= 90 ? ' (' + pct + '%)' : ''}</span>`;
}

function dashboard(user, sites, checksBySite, now, notice) {
  now = now || Date.now();
  const limit = user._limit || PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
  const monitored = sites.filter((s) => s.monitored);
  const down = monitored.filter((s) => s.status && s.status.up === false).length;
  const unpub = monitored.filter((s) => (unpublishedDays(s, now) || 0) >= 7).length;
  const forms7 = monitored.reduce((a, s) => a + ((s.data && s.data.forms && s.data.forms.total7) || 0), 0);
  const seo = monitored.reduce((a, s) => a + ((s.data && s.data.pages && s.data.pages.issues) || 0), 0);

  const rows = sites.map((s) => {
    const sum = summarize(checksBySite[s.id] || [], now - 7 * DAY);
    const f = s.data && s.data.forms;
    const p = s.data && s.data.pages;
    const name = `<a href="/app/site?id=${esc(s.id)}" style="color:inherit;text-decoration:none;font-weight:600">${esc(s.settings.client || s.name)}</a><br><span class="muted small">${esc(s.url.replace(/^https?:\/\//, ''))}</span>`;
    if (!s.monitored) {
      return `<tr><td>${name}</td><td colspan="8"><span class="pill off">Paused</span> <span class="muted small">Over your plan limit of ${limit} sites. <a href="/app/settings#plan">Upgrade</a> to monitor it.</span></td></tr>`;
    }
    return `<tr>
<td>${name}</td>
<td>${statusPill(s)}</td>
<td class="num">${sum.uptime == null ? '-' : sum.uptime + '%'}</td>
<td class="num">${s.status && s.status.ms != null ? s.status.ms + ' ms' : '-'}</td>
<td class="num">${sslCell(s, now)}</td>
<td>${publishCell(s, now)}</td>
<td class="num">${f ? `${f.total7} <span class="muted">/ ${f.total30}</span>` : '-'}</td>
<td class="num">${cmsCell(s)}</td>
<td class="num">${p ? (p.issues ? `<span class="pill warn">${p.issues}</span>` : `<span class="pill ok">0</span>`) : '-'}</td>
</tr>`;
  }).join('');

  const body = `
${notice ? `<div class="notice">${notice}</div>` : ''}
<div class="head"><div><h1>Your sites</h1><p class="muted">${monitored.length} monitored · plan ${esc(user.plan)} (${limit} sites) · checks every 5 minutes</p></div>
<div class="actions"><form method="post" action="/app/sync"><button class="btn" type="submit">Refresh data</button></form><a class="btn primary" href="/auth">Connect sites</a></div></div>
<div class="stats">
<div class="stat"><div class="n">${monitored.length}</div><div class="l">Sites</div></div>
<div class="stat"><div class="n" style="color:${down ? 'var(--bad)' : 'inherit'}">${down}</div><div class="l">Down now</div></div>
<div class="stat"><div class="n" style="color:${unpub ? 'var(--warn)' : 'inherit'}">${unpub}</div><div class="l">Unpublished 7d+</div></div>
<div class="stat"><div class="n">${forms7}</div><div class="l">Form submissions 7d</div></div>
<div class="stat"><div class="n" style="color:${seo ? 'var(--warn)' : 'inherit'}">${seo}</div><div class="l">SEO issues</div></div>
</div>
${sites.length ? `<div class="tablewrap"><table><thead><tr><th>Site</th><th>Status</th><th>Uptime 7d</th><th>Response</th><th>SSL</th><th>Publish</th><th>Forms 7d / 30d</th><th>CMS items</th><th>SEO</th></tr></thead><tbody>${rows}</tbody></table></div>`
: `<div class="panel empty">No sites yet. <a href="/auth">Connect your Webflow sites</a> to start monitoring.</div>`}
<p class="muted small" style="margin-top:12px">Form counts and SEO checks refresh a few times a day; uptime and SSL every 5 minutes. Click a site for details and the client report link.</p>`;
  return layout('Flowdeck', body, { user });
}

function uptimeBars(checks, now) {
  // 7 days in 84 buckets of 2 hours
  const buckets = Array.from({ length: 84 }, () => ({ ok: 0, bad: 0 }));
  const start = now - 7 * DAY;
  for (const c of checks) {
    if (c.t < start) continue;
    const i = Math.min(83, Math.floor((c.t - start) / (2 * 3600000)));
    if (c.ok) buckets[i].ok++; else buckets[i].bad++;
  }
  return `<div class="bars" title="Last 7 days, 2 hour buckets">${buckets.map((b) => {
    if (!b.ok && !b.bad) return '<i class="off" style="height:30%"></i>';
    const pct = b.ok / (b.ok + b.bad);
    return `<i class="${pct < 1 ? 'bad' : ''}" style="height:${Math.max(25, Math.round(pct * 100))}%"></i>`;
  }).join('')}</div>`;
}

function issueList(items, kind) {
  if (!items || !items.length) return '<span class="muted">none</span>';
  return `<ul class="issues">${items.slice(0, 25).map((i) => kind === 'dup'
    ? `<li>"${esc(i.title)}" <span>on ${i.pages.map((p) => esc(p.path)).join(', ')}</span></li>`
    : `<li>${esc(i.label)} <span>${esc(i.path)}${i.length ? ', ' + i.length + ' chars' : ''}</span></li>`).join('')}${items.length > 25 ? `<li class="muted">and ${items.length - 25} more</li>` : ''}</ul>`;
}

function siteDetail(user, site, checks, now, notice) {
  now = now || Date.now();
  const s7 = summarize(checks, now - 7 * DAY);
  const s30 = summarize(checks, now - 30 * DAY);
  const st = site.status || {};
  const f = site.data && site.data.forms;
  const p = site.data && site.data.pages;
  const cms = site.data && site.data.cms;
  const reportUrl = site.settings.reportToken ? `${appUrl()}/r/${site.settings.reportToken}` : '';
  const body = `
${notice ? `<div class="notice">${notice}</div>` : ''}
<div class="head"><div><p class="muted small"><a href="/app">Sites</a> / ${esc(site.name)}</p><h1>${esc(site.settings.client || site.name)}</h1><p class="muted">${esc(site.url)} · ${statusPill(site)} ${st.lastCheckAt ? `<span class="small">checked ${ago(st.lastCheckAt, now)}</span>` : ''}</p></div>
<div class="actions"><a class="btn" href="${esc(site.url)}" target="_blank" rel="noopener">Open site</a>${site.previewUrl ? `<a class="btn" href="${esc(site.previewUrl)}" target="_blank" rel="noopener">Designer</a>` : ''}</div></div>
<div class="stats">
<div class="stat"><div class="n">${s7.uptime == null ? '-' : s7.uptime + '%'}</div><div class="l">Uptime 7d</div></div>
<div class="stat"><div class="n">${s30.uptime == null ? '-' : s30.uptime + '%'}</div><div class="l">Uptime 30d</div></div>
<div class="stat"><div class="n">${s7.avgMs == null ? '-' : s7.avgMs}</div><div class="l">Avg response ms</div></div>
<div class="stat"><div class="n">${st.sslExpiresAt ? days(st.sslExpiresAt, now) : '-'}</div><div class="l">SSL days left</div></div>
<div class="stat"><div class="n">${f ? f.total7 : '-'}</div><div class="l">Forms 7d</div></div>
<div class="stat"><div class="n">${p ? p.issues : '-'}</div><div class="l">SEO issues</div></div>
</div>
<div class="grid">
<div>
<div class="panel"><h3>Uptime, last 7 days</h3>${uptimeBars(checks, now)}<p class="muted small" style="margin-top:8px">${s7.total} checks · ${s7.okCount} ok${st.error ? ' · last error: ' + esc(st.error) : ''}</p></div>
<div class="panel"><h3>Publishing</h3><p style="margin-top:6px">${unpublishedDays(site, now) == null ? '<span class="pill ok">Published</span>' : publishCell(site, now)} <span class="muted small">last published ${esc(fmtDate(site.lastPublished))}, last edited ${esc(fmtDate(site.lastUpdated))}</span></p></div>
<div class="panel"><h3>Forms, last 30 days</h3>${f ? (f.perForm.length ? `<table style="min-width:0"><thead><tr><th>Form</th><th>7d</th><th>30d</th><th>Last</th></tr></thead><tbody>${f.perForm.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${x.count7}</td><td class="num">${x.count30}</td><td>${x.last ? ago(x.last, now) : '-'}</td></tr>`).join('')}</tbody></table>` : '<p class="muted" style="margin-top:6px">No submissions in the last 30 days.</p>') : '<p class="muted" style="margin-top:6px">Not synced yet.</p>'}</div>
<div class="panel"><h3>CMS</h3>${cms ? `<p style="margin-top:6px">${cms.total} items across ${cms.collections.length} collections${CMS_LIMITS[site.settings.plan] ? `, plan limit ${CMS_LIMITS[site.settings.plan]}` : ''}</p><ul class="issues">${cms.collections.slice(0, 15).map((c) => `<li>${esc(c.name)} <span>${c.count}</span></li>`).join('')}</ul>` : '<p class="muted" style="margin-top:6px">Not synced yet.</p>'}</div>
</div>
<div>
<div class="panel"><h3>SEO checks (${p ? p.live : 0} live pages)</h3>${p ? `
<p style="margin-top:8px"><strong>Missing meta title</strong> (${p.missingTitle.length})</p>${issueList(p.missingTitle)}
<p style="margin-top:10px"><strong>Missing meta description</strong> (${p.missingDesc.length})</p>${issueList(p.missingDesc)}
<p style="margin-top:10px"><strong>Duplicate titles</strong> (${p.dupTitle.length})</p>${issueList(p.dupTitle, 'dup')}
<p style="margin-top:10px"><strong>Title over 60 characters</strong> (${p.longTitle.length})</p>${issueList(p.longTitle)}
<p style="margin-top:10px"><strong>Description over 160 characters</strong> (${p.longDesc.length})</p>${issueList(p.longDesc)}` : '<p class="muted" style="margin-top:6px">Not synced yet.</p>'}</div>
<div class="panel"><h3>Client report</h3><p class="muted small" style="margin:6px 0 10px">A white-label page you can send to the client. Shows uptime, forms, publish state and SEO issue counts for the last 30 days.</p>
${reportUrl ? `<p class="mono" style="word-break:break-all">${esc(reportUrl)}</p><div class="actions" style="margin-top:10px"><a class="btn sm" href="${esc(reportUrl)}" target="_blank" rel="noopener">Open report</a><form method="post" action="/app/site/report"><input type="hidden" name="id" value="${esc(site.id)}"><input type="hidden" name="action" value="rotate"><button class="btn sm" type="submit">New link</button></form></div>` : `<form method="post" action="/app/site/report"><input type="hidden" name="id" value="${esc(site.id)}"><input type="hidden" name="action" value="create"><button class="btn sm primary" type="submit">Create report link</button></form>`}</div>
<div class="panel"><h3>Settings</h3>
<form method="post" action="/app/site/settings" class="fields" style="margin-top:10px">
<input type="hidden" name="id" value="${esc(site.id)}">
<div class="field"><label for="client">Client name (shown on the report)</label><input type="text" id="client" name="client" value="${esc(site.settings.client)}" placeholder="${esc(site.name)}"></div>
<div class="field"><label for="plan">Webflow site plan (for CMS limits)</label><select id="plan" name="plan">${['unknown', 'basic', 'cms', 'business', 'enterprise'].map((v) => `<option value="${v}" ${site.settings.plan === v ? 'selected' : ''}>${v === 'unknown' ? 'Not set' : v.charAt(0).toUpperCase() + v.slice(1)}</option>`).join('')}</select></div>
<div class="field"><label for="checkUrl">URL to check (optional)</label><input type="url" id="checkUrl" name="checkUrl" value="${esc(site.settings.checkUrl)}" placeholder="${esc(site.url)}"><span class="hint">Leave empty to check the primary domain.</span></div>
<label class="check"><input type="checkbox" name="alerts" value="1" ${site.settings.alerts !== false ? 'checked' : ''}> Send alerts for this site</label>
<div class="actions"><button class="btn primary" type="submit">Save</button></div>
</form>
<form method="post" action="/app/site/remove" style="margin-top:14px"><input type="hidden" name="id" value="${esc(site.id)}"><button class="btn sm danger" type="submit">Remove from Flowdeck</button></form>
</div>
</div></div>`;
  return layout(site.name + ' · Flowdeck', body, { user });
}

function report(user, site, checks, now) {
  now = now || Date.now();
  const s30 = summarize(checks, now - 30 * DAY);
  const f = site.data && site.data.forms;
  const p = site.data && site.data.pages;
  const st = site.status || {};
  const brand = (user && user.settings && user.settings.brand) || '';
  const body = `
<div class="head"><div><p class="muted small">${esc(brand || 'Site report')}</p><h1>${esc(site.settings.client || site.name)}</h1><p class="muted">${esc(site.url)} · last 30 days · ${new Date(now).toUTCString().slice(0, 16)}</p></div></div>
<div class="stats">
<div class="stat"><div class="n">${s30.uptime == null ? '-' : s30.uptime + '%'}</div><div class="l">Uptime</div></div>
<div class="stat"><div class="n">${s30.avgMs == null ? '-' : s30.avgMs}</div><div class="l">Avg response ms</div></div>
<div class="stat"><div class="n">${f ? f.total30 : '-'}</div><div class="l">Form submissions</div></div>
<div class="stat"><div class="n">${st.sslExpiresAt ? 'Valid' : '-'}</div><div class="l">SSL certificate</div></div>
<div class="stat"><div class="n">${p ? p.issues : '-'}</div><div class="l">SEO issues open</div></div>
</div>
<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr))">
<div class="panel"><h3>Availability</h3>${uptimeBars(checks, now)}<p class="muted small" style="margin-top:8px">${s30.total} checks in the period, ${s30.okCount} successful. Checked every 5 minutes.</p></div>
<div class="panel"><h3>Forms</h3>${f && f.perForm.length ? `<ul class="issues">${f.perForm.map((x) => `<li>${esc(x.name)} <span>${x.count30} submissions</span></li>`).join('')}</ul>` : '<p class="muted" style="margin-top:6px">No submissions in the period.</p>'}</div>
<div class="panel"><h3>Publishing</h3><p style="margin-top:6px">Last published ${esc(fmtDate(site.lastPublished))}. ${unpublishedDays(site, now) == null ? 'Everything is live.' : 'Some changes are waiting to be published.'}</p></div>
<div class="panel"><h3>SEO health</h3>${p ? `<ul class="issues"><li>Pages checked <span>${p.live}</span></li><li>Missing titles <span>${p.missingTitle.length}</span></li><li>Missing descriptions <span>${p.missingDesc.length}</span></li><li>Duplicate titles <span>${p.dupTitle.length}</span></li></ul>` : '<p class="muted">Not available yet.</p>'}</div>
</div>
<p class="muted small" style="margin-top:18px">${esc(brand ? 'Prepared by ' + brand : 'Prepared with Flowdeck')}.</p>`;
  return layout((site.settings.client || site.name) + ' report', body, { plain: true });
}

function settings(user, sites, notice) {
  const limit = user._limit || PLAN_LIMITS[user.plan] || PLAN_LIMITS.free;
  const body = `
${notice ? `<div class="notice">${notice}</div>` : ''}
<div class="head"><div><h1>Settings</h1><p class="muted">${esc(user.email)}</p></div></div>
<div class="grid">
<div class="panel"><h3>Alerts and reports</h3>
<form method="post" action="/app/settings" class="fields" style="margin-top:10px">
<div class="field"><label for="alertEmail">Send alerts and the weekly report to</label><input type="email" id="alertEmail" name="alertEmail" value="${esc(user.settings.alertEmail || user.email)}"></div>
<div class="field"><label for="brand">Agency name (shown on client reports)</label><input type="text" id="brand" name="brand" value="${esc(user.settings.brand)}" placeholder="Your studio"></div>
<label class="check"><input type="checkbox" name="alerts" value="1" ${user.settings.alerts !== false ? 'checked' : ''}> Email me when a site goes down, SSL is about to expire, changes sit unpublished for 7 days, or a form goes silent</label>
<label class="check"><input type="checkbox" name="digest" value="1" ${user.settings.digest !== false ? 'checked' : ''}> Weekly summary every Monday</label>
<div class="actions"><button class="btn primary" type="submit">Save</button></div>
</form></div>
<div class="panel" id="plan"><h3>Plan</h3><p style="margin-top:6px">You are on <strong>${esc(user.plan)}</strong>: up to ${limit} monitored sites. ${sites.length} connected.</p>
<ul class="issues" style="margin-top:8px"><li>Free <span>3 sites</span></li><li>Pro, $29/month <span>25 sites</span></li><li>Agency, $79/month <span>100 sites</span></li></ul>
<p class="muted small" style="margin-top:10px">Need more than ${limit} sites? Write to info@silitlabs.com.</p></div>
<div class="panel"><h3>Webflow connections</h3><p class="muted small" style="margin:6px 0 10px">Each connection is one Webflow authorization. Connect again to add sites from another workspace.</p>
<ul class="issues">${user.connections.map((c) => `<li>${esc(c.label || 'Connection')} <span>${new Date(c.authorizedAt).toISOString().slice(0, 10)}, ${sites.filter((s) => s.connectionId === c.id).length} sites</span></li>`).join('') || '<li class="muted">None yet</li>'}</ul>
<div class="actions" style="margin-top:10px"><a class="btn" href="/auth">Connect more sites</a></div></div>
<div class="panel"><h3>Delete account</h3><p class="muted small" style="margin:6px 0 10px">Removes your sites, checks and tokens from Flowdeck. Your Webflow sites are not affected.</p>
<form method="post" action="/app/delete"><button class="btn sm danger" type="submit">Delete my Flowdeck account</button></form></div>
</div>`;
  return layout('Settings · Flowdeck', body, { user });
}

module.exports = { layout, errorPage, dashboard, siteDetail, report, settings, esc, ago, fmtDate };
