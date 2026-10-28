// Renders the app pages with example data and captures Marketplace screenshots (1280x846).
// Run: node scripts/screenshots.js   (needs playwright + sharp available)
'use strict';
process.env.APP_URL = process.env.APP_URL || 'https://flowdeck.silitlabs.com';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'screenshots';

const fs = require('fs');
const path = require('path');
const html = require('../api/_lib/html');
const { digestHtml } = require('../api/_lib/jobs');

const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

function checks(days, downWindows) {
  // one check every 5 minutes for `days` days; downWindows: [[startAgoMs, endAgoMs], ...]
  const out = [];
  for (let t = now - days * DAY; t <= now; t += 300000) {
    const ago = now - t;
    const down = (downWindows || []).some(([a, b]) => ago <= a && ago >= b);
    out.push({ t, ok: !down, code: down ? 503 : 200, ms: down ? 0 : 180 + Math.round(Math.random() * 220) });
  }
  return out.reverse();
}

const user = {
  id: 'u1', email: 'hello@northstudio.co', name: 'North Studio', plan: 'free', _limit: 25,
  settings: { digest: true, alerts: true, brand: 'North Studio', alertEmail: 'alerts@northstudio.co' },
  connections: [{ id: 'c1', label: 'hello@northstudio.co', authorizedAt: now - 40 * DAY }],
  siteIds: ['s1', 's2', 's3', 's4', 's5', 's6']
};

function site(id, name, domain, opts) {
  const o = Object.assign({ up: true, ms: 240, ssl: 71, published: 2, updated: 3, plan: 'cms', client: '', forms7: 0, forms30: 0, perForm: [], cms: 0, issues: 0, pages: null }, opts);
  return {
    id, userId: 'u1', connectionId: 'c1', name, shortName: domain.split('.')[0], domains: [domain], url: 'https://' + domain,
    previewUrl: 'https://webflow.com/design/' + domain.split('.')[0],
    lastPublished: iso(now - o.published * DAY), lastUpdated: iso(now - o.updated * DAY), createdAt: now - 30 * DAY, monitored: o.monitored !== false,
    settings: { plan: o.plan, client: o.client, alerts: true, checkUrl: '', reportToken: o.report || '' },
    data: {
      syncedAt: now - 3600000, errors: [],
      pages: o.pages || { total: 14, live: 12, missingTitle: [], missingDesc: [], longTitle: [], longDesc: [], dupTitle: [], issues: o.issues },
      forms: { total7: o.forms7, total30: o.forms30, last: now - DAY, perForm: o.perForm, before30: 0 },
      cms: { total: o.cms, collections: o.collections || [] }
    },
    status: { up: o.up, since: now - 5 * DAY, lastCheckAt: now - 120000, code: o.up ? 200 : 503, ms: o.ms, fails: o.up ? 0 : 3, sslExpiresAt: now + o.ssl * DAY, sslCheckedAt: now - 600000, sslError: '' },
    syncedAt: now - 3600000, syncError: ''
  };
}

const sites = [
  site('s1', 'Harbour Dental', 'harbourdental.co.uk', { client: 'Harbour Dental Clinic', forms7: 14, forms30: 61, cms: 1940, issues: 4, ssl: 71, published: 1, updated: 1,
    perForm: [{ name: 'Book a consultation', count7: 9, count30: 41, last: now - 3600000 * 5 }, { name: 'Contact form', count7: 4, count30: 17, last: now - DAY }, { name: 'Newsletter', count7: 1, count30: 3, last: now - 6 * DAY }],
    collections: [{ name: 'Blog posts', count: 1812 }, { name: 'Treatments', count: 64 }, { name: 'Team', count: 38 }, { name: 'Testimonials', count: 26 }],
    pages: { total: 46, live: 41, issues: 4,
      missingTitle: [{ label: 'Smile gallery', path: '/gallery' }],
      missingDesc: [{ label: 'Smile gallery', path: '/gallery' }, { label: 'Careers', path: '/careers' }],
      longTitle: [], longDesc: [{ label: 'Dental implants', path: '/treatments/dental-implants', length: 182 }], dupTitle: [] } }),
  site('s2', 'Nordic Yacht Charter', 'nordicyacht.com', { up: false, ms: 0, client: 'Nordic Yacht Charter', forms7: 0, forms30: 23, cms: 312, issues: 0, ssl: 12, published: 9, updated: 1, plan: 'business',
    perForm: [{ name: 'Charter enquiry', count7: 0, count30: 23, last: now - 8 * DAY }] }),
  site('s3', 'Lumen Architects', 'lumen.studio', { forms7: 3, forms30: 9, cms: 88, issues: 0, ssl: 58, published: 0, updated: 2, plan: 'cms', perForm: [{ name: 'Project enquiry', count7: 3, count30: 9, last: now - 2 * DAY }] }),
  site('s4', 'Fjord Coffee Roasters', 'fjordcoffee.no', { forms7: 2, forms30: 11, cms: 1540, issues: 2, ssl: 33, published: 3, updated: 3, plan: 'cms', ms: 310 }),
  site('s5', 'Pelican Legal', 'pelicanlegal.ie', { forms7: 6, forms30: 28, cms: 140, issues: 1, ssl: 80, published: 12, updated: 2, plan: 'basic', ms: 190 }),
  site('s6', 'Atlas Fitness', 'atlasfitness.app', { forms7: 0, forms30: 0, cms: 20, issues: 0, ssl: 45, published: 1, updated: 1, plan: 'unknown', ms: 150, monitored: true })
];

const checksBySite = {
  s1: checks(7), s2: checks(7, [[2 * 3600000, 0], [3 * DAY + 3600000, 3 * DAY]]), s3: checks(7), s4: checks(7, [[5 * DAY + 1800000, 5 * DAY]]), s5: checks(7), s6: checks(2)
};

sites[0].settings.reportToken = 'k8Q2mLw9vT4pXc1R';

const out = path.join(__dirname, '..', 'assets', 'screenshots');
fs.mkdirSync(out, { recursive: true });

const pages = {
  '1-dashboard': html.dashboard(user, sites, checksBySite, now, ''),
  '2-site-detail': html.siteDetail(user, sites[0], checksBySite.s1, now, ''),
  '3-client-report': html.report(user, sites[0], checksBySite.s1, now),
  '4-settings': html.settings(user, sites, ''),
  '5-weekly-email': `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#f4f6f8;padding:40px;font-family:Figtree,Segoe UI,Helvetica,Arial,sans-serif}.mail{max-width:900px;margin:0 auto;background:#fff;border:1px solid #dbe1e8;border-radius:12px;padding:28px}.hdr{font-size:13px;color:#5b6876;margin-bottom:18px;padding-bottom:12px;border-bottom:1px solid #dbe1e8}</style></head><body><div class="mail"><div class="hdr"><strong>From:</strong> Flowdeck &lt;alerts@silitlabs.com&gt; &nbsp; <strong>To:</strong> alerts@northstudio.co &nbsp; <strong>Subject:</strong> [Flowdeck] Weekly report: 6 sites</div>${digestHtml(user, sites.map((s) => Object.assign({}, s, { _checks: checksBySite[s.id] })), now)}</div></body></html>`
};

for (const [name, content] of Object.entries(pages)) fs.writeFileSync(path.join(out, name + '.html'), content);

(async () => {
  const { chromium } = require('playwright');
  const sharp = require('sharp');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 846 }, deviceScaleFactor: 2 });
  for (const name of Object.keys(pages)) {
    const page = await ctx.newPage();
    await page.goto('file://' + path.join(out, name + '.html'), { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const raw = path.join(out, name + '@2x.png');
    await page.screenshot({ path: raw, fullPage: false });
    await sharp(raw).resize(1280, 846).png({ compressionLevel: 9 }).toFile(path.join(out, name + '.png'));
    fs.unlinkSync(raw);
    await page.close();
    console.log('wrote', name + '.png');
  }
  await browser.close();
})();
