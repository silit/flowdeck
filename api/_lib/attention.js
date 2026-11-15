'use strict';
// What needs attention now, ranked by impact. Used by the dashboard, the site page, the settings page
// and the weekly email, so they always agree. Read only: it looks at the stored site records and
// never changes them. The alert emails keep their own rules in alerts.js.
//
// Each item: { key, type, sev: 'bad' | 'warn', score, site, title, detail, short, data }
//   sev   'bad' when something is broken now (site down, certificate expired), 'warn' otherwise
//   score higher first; roughly: down 100, SSL expired or not valid 95, SSL expiring 66 to 94
//         (sooner is higher), CMS full 76, forms silent 72, no Webflow access 64, CMS over 90% 58 to 67,
//         unpublished for 7 days or more 50 to 57, sites over the plan limit 45, SEO gaps 20 to 30
const { unpublishedDays, DAY } = require('./sync');
const { CMS_LIMITS } = require('./store');

const MIN = 60000;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

function hostOf(site) {
  try { return new URL(site.url).host || site.name; } catch (e) { return site.name || ''; }
}
function nameOf(site) { return (site.settings && site.settings.client) || site.name || hostOf(site); }

// "25 minutes", "3 hours", "2 days"
function duration(ms) {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return plural(m, 'minute');
  const h = Math.round(m / 60);
  if (h < 48) return plural(h, 'hour');
  return plural(Math.round(h / 24), 'day');
}
// "15 Nov 2026"
function day(ts) {
  const d = new Date(typeof ts === 'string' ? Date.parse(ts) : ts);
  if (isNaN(d)) return '';
  return d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}
// "15 Nov 2026, 13:41 UTC"
function moment(ts) {
  const d = new Date(typeof ts === 'string' ? Date.parse(ts) : ts);
  if (isNaN(d)) return '';
  return day(d) + ', ' + d.toISOString().slice(11, 16) + ' UTC';
}

const PLAN_NAMES = { basic: 'Basic', cms: 'CMS', business: 'Business', enterprise: 'Enterprise' };

// Short summary of the SEO findings, e.g. "1 missing title, 2 missing descriptions"
function seoSummary(p) {
  const parts = [];
  if (p.missingTitle.length) parts.push(plural(p.missingTitle.length, 'missing title'));
  if (p.missingDesc.length) parts.push(plural(p.missingDesc.length, 'missing description'));
  if (p.dupTitle.length) parts.push(plural(p.dupTitle.length, 'duplicate title'));
  if (p.longTitle.length) parts.push(plural(p.longTitle.length, 'long title'));
  if (p.longDesc.length) parts.push(plural(p.longDesc.length, 'long description'));
  return parts.join(', ');
}

// SSL state of a site, shared by the table, the site page, the report and the items below.
// state: 'none' (not checked yet), 'invalid', 'expired', 'expiring' (14 days or less), 'error', 'ok'
function sslState(site, now) {
  const st = site.status || {};
  if (!st.sslCheckedAt) return { state: 'none' };
  if (!st.sslExpiresAt) return { state: 'invalid', error: st.sslError || '' };
  const days = Math.floor((st.sslExpiresAt - now) / DAY);
  if (st.sslExpiresAt <= now) return { state: 'expired', days, expiresAt: st.sslExpiresAt };
  if (days <= 14) return { state: 'expiring', days, expiresAt: st.sslExpiresAt };
  if (st.sslError) return { state: 'error', days, expiresAt: st.sslExpiresAt, error: st.sslError };
  return { state: 'ok', days, expiresAt: st.sslExpiresAt };
}

// CMS usage against the site plan; null when there is no data or no limit for the plan.
function cmsUsage(site) {
  const cms = site.data && site.data.cms;
  if (!cms) return null;
  const limit = CMS_LIMITS[site.settings && site.settings.plan] || 0;
  if (!limit) return { total: cms.total, limit: 0, pct: null };
  return { total: cms.total, limit, pct: Math.round((cms.total / limit) * 100) };
}

// Messages the sync job stores when Webflow does not let Flowdeck read the site.
const ACCESS_RE = /No Webflow access|Webflow refused access/;

// The site in the Webflow Designer, in the form Webflow documents for deep links
// (https://<site short name>.design.webflow.com). Empty when the short name is unknown.
function designerUrl(site) {
  const s = String((site && site.shortName) || '');
  return /^[a-z0-9][a-z0-9-]{0,62}$/i.test(s) ? 'https://' + s.toLowerCase() + '.design.webflow.com' : '';
}

// One sentence naming the site, for lists that mix sites (the weekly email).
const HEADLINES = {
  down: (n) => `${n} is down`,
  ssl: (n, i) => ({ expired: `The SSL certificate on ${n} has expired`, invalid: `The SSL certificate on ${n} is not valid`, error: `The SSL certificate on ${n} needs a check` }[i.data.state] || `The SSL certificate on ${n} ${i.data.days < 1 ? 'expires today' : 'expires in ' + plural(i.data.days, 'day')}`),
  forms_silent: (n) => `${n} has had no form submissions for 30 days`,
  access: (n) => `Flowdeck cannot read ${n} from Webflow`,
  cms: (n, i) => (i.data.pct >= 100 ? `The CMS on ${n} is full` : `The CMS on ${n} is ${i.data.pct}% full`),
  unpublished: (n, i) => `${n} has changes unpublished for ${plural(i.data.days, 'day')}`,
  seo: (n, i) => `${n} has ${plural(i.data.issues, 'SEO issue')}`
};
function headline(item) {
  if (!item.site) return item.title;
  const h = HEADLINES[item.type];
  return h ? h(nameOf(item.site), item) : nameOf(item.site) + ': ' + item.title;
}

function siteItems(site, now) {
  now = now || Date.now();
  if (!site || !site.monitored) return [];
  const out = [];
  const st = site.status || {};
  const add = (type, sev, score, title, detail, short, data) => out.push({ key: type + ':' + site.id, type, sev, score, site, title, detail, short, data: data || {} });

  if (st.up === false) {
    const since = st.since || st.lastCheckAt;
    const answer = st.code ? String(st.code) : 'no response';
    add('down', 'bad', 100, 'Site is down',
      `${since ? 'Down for ' + duration(now - since) + '. ' : ''}Last answer: ${answer}${st.error ? ' (' + st.error + ')' : ''}, ${plural(st.fails || 2, 'failed check')} in a row.`,
      'Down', { since, code: st.code, error: st.error || '', fails: st.fails || 0 });
  }

  // When the site does not answer at all, the certificate cannot be read either: the down item covers
  // that. A date that was read (the server answered, even with an error page) still counts.
  const ssl = sslState(site, now);
  if (ssl.state === 'expired') add('ssl', 'bad', 96, 'SSL certificate expired', `It expired on ${day(ssl.expiresAt)}. Visitors see a security warning. Check the domain settings in Webflow.`, 'SSL expired', ssl);
  else if (ssl.state === 'invalid' && st.up !== false) add('ssl', 'bad', 95, 'SSL certificate not valid', `Flowdeck could not read a valid certificate${ssl.error ? ' (' + ssl.error + ')' : ''}. Visitors may see a security warning.`, 'SSL not valid', ssl);
  else if (ssl.state === 'expiring') add('ssl', 'warn', 66 + (14 - Math.max(0, ssl.days)) * 2, ssl.days < 1 ? 'SSL certificate expires today' : `SSL certificate expires in ${plural(ssl.days, 'day')}`, `On ${day(ssl.expiresAt)}. Webflow renews certificates for the domains it hosts. If the date does not move in a few days, check the DNS records.`, ssl.days < 1 ? 'SSL today' : `SSL in ${plural(ssl.days, 'day')}`, ssl);
  else if (ssl.state === 'error' && st.up !== false) add('ssl', 'warn', 65, 'SSL certificate needs a check', `It is valid until ${day(ssl.expiresAt)}, but the check reported: ${ssl.error}.`, 'SSL check', ssl);

  const f = site.data && site.data.forms;
  if (f && f.total30 === 0 && f.before30 > 0) add('forms_silent', 'warn', 72, 'No form submissions for 30 days', `There were ${f.before30} in the 30 days before. Send a test entry to make sure the form still works.`, 'Forms silent', { before: f.before30 });

  if (site.syncError && ACCESS_RE.test(site.syncError)) add('access', 'warn', 64, 'Flowdeck cannot read this site from Webflow', site.syncError, 'No access');

  const cms = cmsUsage(site);
  if (cms && cms.pct != null && cms.pct >= 90) {
    const plan = PLAN_NAMES[site.settings.plan] || site.settings.plan;
    if (cms.pct >= 100) add('cms', 'bad', 76, 'CMS is full', `${cms.total} of ${cms.limit} items on the ${plan} plan. New items cannot be added. Upgrade the site plan or remove old items.`, 'CMS full', cms);
    else add('cms', 'warn', 58 + (cms.pct - 90), `CMS is ${cms.pct}% full`, `${cms.total} of ${cms.limit} items on the ${plan} plan. New items fail at the limit.`, `CMS ${cms.pct}%`, cms);
  }

  const ud = unpublishedDays(site, now);
  if (ud != null && ud >= 7) add('unpublished', 'warn', 50 + Math.min(ud - 7, 21) / 3, `Changes unpublished for ${plural(ud, 'day')}`, `Last published ${day(site.lastPublished) || 'never'}. Publish the site, or discard the changes if they are not ready.`, `Unpublished ${plural(ud, 'day')}`, { days: ud });

  const p = site.data && site.data.pages;
  if (p && p.issues > 0) add('seo', 'warn', 20 + Math.min(p.issues, 40) / 4, plural(p.issues, 'SEO issue'), seoSummary(p) + '.', plural(p.issues, 'SEO issue'), { issues: p.issues });

  return out;
}

const SEV = { bad: 2, warn: 1 };
function byImpact(a, b) {
  return (b.score - a.score) || (SEV[b.sev] - SEV[a.sev]) || String(a.site ? nameOf(a.site) : '').localeCompare(b.site ? nameOf(b.site) : '');
}

// Every item for a list of sites, most urgent first. opts.limit adds one account item when sites
// are paused only because of the plan limit (opts.limit: { max, planName }).
function rank(sites, now, opts) {
  now = now || Date.now();
  opts = opts || {};
  const items = [];
  for (const s of sites || []) items.push(...siteItems(s, now));
  const over = (sites || []).filter((s) => !s.monitored && !s.pausedByUser);
  if (opts.limit && over.length) {
    items.push({ key: 'limit', type: 'limit', sev: 'warn', score: 45, site: null,
      title: `${plural(over.length, 'site')} not monitored`,
      detail: `Your ${opts.limit.planName} plan monitors up to ${plural(opts.limit.max, 'site')}. Upgrade to monitor the rest.`,
      short: 'Over the plan limit', data: { sites: over.length } });
  }
  return items.sort(byImpact);
}

// The worst score per site, for sorting the site table most urgent first.
function siteScore(site, now) {
  const items = siteItems(site, now);
  return items.length ? Math.max(...items.map((i) => i.score)) : 0;
}

module.exports = { siteItems, rank, siteScore, sslState, cmsUsage, hostOf, nameOf, designerUrl, headline, duration, day, moment, plural, seoSummary, PLAN_NAMES };
