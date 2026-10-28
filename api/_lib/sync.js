'use strict';
// Pulls Webflow data for one site: metadata, pages (SEO issues), forms (submission counts), CMS usage.
const wf = require('./webflow');
const store = require('./store');

const DAY = 86400000;

function analyzePages(pages) {
  const live = pages.filter((p) => !p.archived && !p.draft);
  const seoTitle = (p) => (p.seo && p.seo.title) || '';
  const seoDesc = (p) => (p.seo && p.seo.description) || '';
  const missingTitle = [];
  const missingDesc = [];
  const longTitle = [];
  const longDesc = [];
  const titles = {};
  for (const p of live) {
    const t = seoTitle(p).trim();
    const d = seoDesc(p).trim();
    const label = p.title || p.slug || p.id;
    const path = p.publishedPath || ('/' + (p.slug || ''));
    if (!t) missingTitle.push({ label, path });
    if (!d) missingDesc.push({ label, path });
    if (t.length > 60) longTitle.push({ label, path, length: t.length });
    if (d.length > 160) longDesc.push({ label, path, length: d.length });
    if (t) (titles[t.toLowerCase()] = titles[t.toLowerCase()] || []).push({ label, path });
  }
  const dupTitle = Object.values(titles).filter((arr) => arr.length > 1).map((arr) => ({ title: arr[0].label, pages: arr }));
  const issues = missingTitle.length + missingDesc.length + longTitle.length + longDesc.length + dupTitle.length;
  return { total: pages.length, live: live.length, missingTitle, missingDesc, longTitle, longDesc, dupTitle, issues };
}

function analyzeSubmissions(subs, now) {
  const d7 = now - 7 * DAY;
  const d30 = now - 30 * DAY;
  const perForm = {};
  let total7 = 0, total30 = 0, last = 0;
  for (const s of subs) {
    if (s.at >= d30) total30++;
    if (s.at >= d7) total7++;
    if (s.at > last) last = s.at;
    const f = perForm[s.form] = perForm[s.form] || { name: s.form, count7: 0, count30: 0, last: 0 };
    if (s.at >= d30) f.count30++;
    if (s.at >= d7) f.count7++;
    if (s.at > f.last) f.last = s.at;
  }
  return { total7, total30, last, perForm: Object.values(perForm).sort((a, b) => b.count30 - a.count30) };
}

async function syncSite(site, token, opts) {
  const now = Date.now();
  const limits = Object.assign({ pages: 500, collections: 30, submissions: 500 }, opts || {});
  const data = { syncedAt: now, errors: [] };

  try {
    const meta = await wf.getSite(token, site.id);
    store.refreshMeta(site, meta);
  } catch (e) { data.errors.push('site: ' + e.message); }

  try {
    const pages = await wf.listPages(token, site.id, limits.pages);
    data.pages = analyzePages(pages);
  } catch (e) { data.errors.push('pages: ' + e.message); }

  try {
    const subs = await wf.listSubmissions(token, site.id, now - 30 * DAY, limits.submissions);
    data.forms = analyzeSubmissions(subs, now);
  } catch (e) { data.errors.push('forms: ' + e.message); }

  try {
    const collections = (await wf.listCollections(token, site.id)).slice(0, limits.collections);
    const items = [];
    let total = 0;
    for (const c of collections) {
      const count = await wf.countItems(token, c.id);
      items.push({ name: c.displayName || c.slug, count });
      total += count;
    }
    data.cms = { collections: items.sort((a, b) => b.count - a.count), total };
  } catch (e) { data.errors.push('cms: ' + e.message); }

  site.data = data;
  site.syncedAt = now;
  site.syncError = data.errors.join('; ');
  return site;
}

// Days since the last publish while there are newer design changes. null when published.
function unpublishedDays(site, now) {
  const up = Date.parse(site.lastUpdated || 0) || 0;
  const pub = Date.parse(site.lastPublished || 0) || 0;
  if (!up || up <= pub) return null;
  return Math.floor(((now || Date.now()) - pub) / DAY);
}

module.exports = { syncSite, analyzePages, analyzeSubmissions, unpublishedDays, DAY };
