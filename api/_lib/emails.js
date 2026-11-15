'use strict';
// Every email Flowdeck sends: alert opened, alert resolved, weekly report, sign in link.
// Each builder returns { subject, html, text }.
// - The subject says the state and the site ("Down: clientsite.com").
// - The first line says what happened and what to do, then one button, then the details.
// - HTML: tables with inline styles, at most 600 px wide, no images that carry meaning, so it reads
//   the same in Gmail, Outlook and Apple Mail. Mail apps that support dark mode get dark colours from
//   the style block; the others invert the light design, which keeps its contrast.
// - The text version says the same things in the same order.
const checks = require('./checks');
const att = require('./attention');

const { plural, day, moment, duration } = att;
const DAY = 86400000;
const appUrl = () => (process.env.APP_URL || '').replace(/\/+$/, '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FONT = "Figtree,'Segoe UI',Helvetica,Arial,sans-serif";
const HEAD = "'Bricolage Grotesque',Figtree,'Segoe UI',Helvetica,Arial,sans-serif";
const C = { page: '#f4f6f8', card: '#ffffff', fg: '#121a24', muted: '#5b6876', line: '#dbe1e8', accent: '#1f6feb', link: '#1a5fd0' };
// Status badges: a mark of its own shape plus a word; the fills also differ in lightness.
const BADGE = {
  bad: { bg: '#b42318', fg: '#ffffff', mark: '&#10005;', cls: 'fd-bad' },
  warn: { bg: '#f5b324', fg: '#3d2a00', mark: '!', cls: 'fd-warn' },
  ok: { bg: '#e3f5ea', fg: '#0e6b3f', mark: '&#10003;', cls: 'fd-ok' },
  off: { bg: '#eef2f6', fg: '#46515e', mark: '-', cls: 'fd-off' }
};

const STYLE = `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0}
a.fd-btn:hover{background-color:#185ed0 !important}
@media (prefers-color-scheme: dark){
.fd-page{background-color:#0f141a !important}
.fd-card{background-color:#161d26 !important;border-color:#2a3441 !important}
.fd-fg{color:#e8edf2 !important}
.fd-muted{color:#a8b4c0 !important}
.fd-line{border-color:#2a3441 !important}
.fd-a,.fd-deck{color:#8ab8ff !important}
.fd-ok{background-color:#133526 !important;color:#8fe3b4 !important}
.fd-off{background-color:#232c37 !important;color:#c9d2db !important}
}
@media (max-width:620px){
.fd-pad{padding:22px 18px !important}
.fd-h1{font-size:21px !important;line-height:27px !important}
}
</style>`;
// Outlook.com dark mode marks the elements it recolours; kept apart so a mail app that rejects the
// attribute selectors drops only this block.
const STYLE_OUTLOOK = `<style>
[data-ogsc] .fd-fg{color:#e8edf2 !important}
[data-ogsc] .fd-muted{color:#a8b4c0 !important}
[data-ogsc] .fd-a,[data-ogsc] .fd-deck{color:#8ab8ff !important}
[data-ogsb] .fd-page{background-color:#0f141a !important}
[data-ogsb] .fd-card{background-color:#161d26 !important}
</style>`;

/* ---------- html parts ---------- */

// The wordmark is text, not an image: pictures are blocked by default in some mail apps (Outlook).
function brand() {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="fd-fg" style="vertical-align:middle;font-family:${HEAD};font-size:20px;line-height:24px;font-weight:700;color:${C.fg};">Flow<span class="fd-deck" style="color:${C.accent};">deck</span></td></tr></table>`;
}
function badge(sev, label) {
  const b = BADGE[sev];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td class="${b.cls}" bgcolor="${b.bg}" style="background-color:${b.bg};border-radius:6px;padding:5px 10px;font-family:${FONT};font-size:13px;line-height:16px;font-weight:700;color:${b.fg};white-space:nowrap;">${b.mark}&nbsp;&nbsp;${esc(label)}</td></tr></table>`;
}
// A small square mark for list rows (the words sit next to it)
function mark(sev) {
  const b = BADGE[sev];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td class="${b.cls}" bgcolor="${b.bg}" width="22" height="22" align="center" style="width:22px;height:22px;background-color:${b.bg};border-radius:5px;font-family:${FONT};font-size:13px;line-height:22px;font-weight:700;color:${b.fg};text-align:center;">${b.mark}</td></tr></table>`;
}
const h1 = (t) => `<h1 class="fd-fg fd-h1" style="margin:14px 0 0;font-family:${HEAD};font-size:24px;line-height:30px;font-weight:700;color:${C.fg};">${esc(t)}</h1>`;
const lead = (t) => `<p class="fd-fg" style="margin:10px 0 0;font-family:${FONT};font-size:16px;line-height:24px;color:${C.fg};">${esc(t)}</p>`;
const h2 = (t) => `<h2 class="fd-fg" style="margin:28px 0 6px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:${C.fg};">${esc(t)}</h2>`;
const small = (html, top) => `<p class="fd-muted" style="margin:${top == null ? 10 : top}px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">${html}</p>`;
const link = (href, label) => `<a class="fd-a" href="${esc(href)}" target="_blank" style="color:${C.link};text-decoration:underline;${/^https?:\/\//.test(label) ? 'word-break:break-all;' : ''}">${esc(label)}</a>`;
function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;border-collapse:separate;"><tr><td bgcolor="${C.accent}" style="background-color:${C.accent};border-radius:8px;mso-padding-alt:12px 22px;"><a class="fd-btn" href="${esc(href)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">${esc(label)}</a></td></tr></table>`;
}
const isUrl = (v) => /^https?:\/\//.test(String(v));
function details(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows.map(([k, v]) => `<tr><td class="fd-muted fd-line" valign="top" style="width:38%;padding:9px 12px 9px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">${esc(k)}</td><td class="fd-fg fd-line" valign="top" style="padding:9px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:14px;line-height:20px;color:${C.fg};word-break:break-word;">${isUrl(v) ? link(v, v) : esc(v)}</td></tr>`).join('')}</table>`;
}

function shell({ subject, preheader, body, footer }) {
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
${STYLE}
${STYLE_OUTLOOK}
</head>
<body class="fd-page" style="margin:0;padding:0;width:100%;background-color:${C.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${esc(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="fd-page" bgcolor="${C.page}" style="background-color:${C.page};">
<tr><td align="center" style="padding:24px 12px 32px;">
<!--[if mso]><table role="presentation" align="center" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
<tr><td style="padding:0 4px 14px;">${brand()}</td></tr>
<tr><td class="fd-card fd-pad" bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:12px;padding:28px 32px;">
${body}
</td></tr>
<tr><td class="fd-muted" style="padding:16px 4px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.muted};">${footer}</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/* ---------- one message, two renderings ---------- */

// m: { subject, badge: [sev, word], title, lead, button: { href, label }, also: { href, label },
//      sections: [{ heading, rows } | { heading, html, text }], footer: { html, text } }
function render(m) {
  const sections = (m.sections || []).map((s) => `${h2(s.heading)}${s.rows ? details(s.rows) : s.html}`).join('');
  const html = shell({
    subject: m.subject,
    preheader: m.lead,
    body: `${m.badge ? badge(m.badge[0], m.badge[1]) : ''}${h1(m.title)}${lead(m.lead)}${m.button ? button(m.button.href, m.button.label) : ''}${m.also ? small(`Or ${link(m.also.href, m.also.label.charAt(0).toLowerCase() + m.also.label.slice(1))}.`, 12) : ''}${sections}${m.after || ''}`,
    footer: m.footer.html
  });
  const text = [
    m.title, '', m.lead, '',
    m.button ? `${m.button.label}: ${m.button.href}` : '',
    ...(m.sections || []).filter((s) => s.text !== null).map((s) => '\n' + s.heading + '\n' + (s.rows ? s.rows.map(([k, v]) => `${k}: ${v}`).join('\n') : s.text)),
    m.also ? `\n${m.also.label}: ${m.also.href}` : '',
    m.afterText ? '\n' + m.afterText : '',
    '\n' + m.footer.text
  ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { subject: m.subject, html, text };
}

function alertFooter(to) {
  const settings = appUrl() + '/app/settings';
  return {
    html: `You get this email because Flowdeck alerts are on${to ? ' for ' + esc(to) : ''}. ${link(settings, 'Change alert emails in Settings')}.<br>Flowdeck. Not affiliated with Webflow.`,
    text: `You get this email because Flowdeck alerts are on${to ? ' for ' + to : ''}. Change alert emails in Settings: ${settings}`
  };
}

/* ---------- alerts ---------- */

// d is what the alert rule found (alerts.evaluate): down { fails, code, error }, ssl { days, expiresAt },
// unpublished { days }, forms_silent { before }.
function alertOpened(site, type, d, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  d = d || {};
  const host = att.hostOf(site);
  const name = att.nameOf(site);
  const page = appUrl() + '/app/site?id=' + encodeURIComponent(site.id);
  const base = [['Site', name], ['Address', site.url]];
  const m = { footer: alertFooter(opts.to) };
  if (type === 'down') {
    const checked = checks.checkUrlOf(site) || site.url;
    const answer = (d.code ? String(d.code) : 'No response') + (d.error ? ` (${d.error})` : '');
    Object.assign(m, {
      subject: `Down: ${host}`,
      badge: ['bad', 'Down'],
      title: `${name} is down`,
      lead: `${host} failed ${plural(d.fails || 2, 'check')} in a row, 5 minutes apart. Open it to confirm, then check the hosting and DNS settings in Webflow.`,
      button: { href: checked, label: `Open ${host}` },
      also: { href: page, label: 'See the checks in Flowdeck' },
      sections: [{ heading: 'Details', rows: base.concat(checked !== site.url ? [['Checked address', checked]] : [], [['Last answer', answer], ['Failed checks in a row', String(d.fails || 2)], ['Down since', moment((site.status && site.status.since) || now)]]) }]
    });
  } else if (type === 'ssl') {
    const expired = d.expiresAt ? d.expiresAt <= now : d.days < 0;
    const when = d.days < 1 ? 'today' : 'in ' + plural(d.days, 'day');
    Object.assign(m, expired ? {
      subject: `SSL expired: ${host}`,
      badge: ['bad', 'Expired'],
      title: `The SSL certificate on ${name} has expired`,
      lead: `Visitors to ${host} now see a security warning. Check the domain settings in Webflow so a new certificate is issued.`,
      button: { href: site.url, label: `Open ${host}` },
      also: { href: page, label: 'See the site in Flowdeck' },
      sections: [{ heading: 'Details', rows: base.concat([['Expired on', moment(d.expiresAt)]]) }]
    } : {
      subject: `SSL expires ${when}: ${host}`,
      badge: ['warn', `Expires ${when}`],
      title: `The SSL certificate on ${name} expires ${when}`,
      lead: `Webflow renews certificates for the domains it hosts, so this usually fixes itself. If the date does not move in a few days, check the domain's DNS records in Webflow.`,
      button: { href: page, label: 'See the date in Flowdeck' },
      also: { href: site.url, label: `Open ${host}` },
      sections: [{ heading: 'Details', rows: base.concat([['Expires on', moment(d.expiresAt)]]) }]
    });
  } else if (type === 'unpublished') {
    const designer = att.designerUrl(site);
    Object.assign(m, {
      subject: `Unpublished for ${plural(d.days, 'day')}: ${host}`,
      badge: ['warn', `Unpublished ${plural(d.days, 'day')}`],
      title: `${name} has changes waiting to be published`,
      lead: `Changes made in the Designer have not been published for ${plural(d.days, 'day')}. Publish the site, or discard the changes if they are not ready.`,
      button: designer ? { href: designer, label: 'Open the Designer' } : { href: page, label: 'Open in Flowdeck' },
      also: designer ? { href: page, label: 'See the site in Flowdeck' } : null,
      sections: [{ heading: 'Details', rows: base.concat([['Last published', site.lastPublished ? moment(site.lastPublished) : 'Never'], ['Last edited', site.lastUpdated ? moment(site.lastUpdated) : 'Unknown']]) }]
    });
  } else if (type === 'forms_silent') {
    Object.assign(m, {
      subject: `No form submissions for 30 days: ${host}`,
      badge: ['warn', 'Forms silent'],
      title: `${name} has had no form submissions for 30 days`,
      lead: `It had ${plural(d.before, 'submission')} in the 30 days before. Send a test entry to make sure the form still works and its notification emails arrive.`,
      button: { href: site.url, label: `Open ${host}` },
      also: { href: page, label: 'See the forms in Flowdeck' },
      sections: [{ heading: 'Details', rows: base.concat([['Last 30 days', '0 submissions'], ['30 days before', plural(d.before, 'submission')]]) }]
    });
  } else {
    Object.assign(m, { subject: `Alert: ${host}`, badge: ['warn', 'Alert'], title: `${name} needs a look`, lead: 'Open Flowdeck to see what changed.', button: { href: page, label: 'Open in Flowdeck' }, sections: [{ heading: 'Details', rows: base }] });
  }
  return Object.assign(render(m), { title: m.title, lead: m.lead });
}

// state is the stored alert: { since, detail }
function alertResolved(site, type, state, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const host = att.hostOf(site);
  const name = att.nameOf(site);
  const page = appUrl() + '/app/site?id=' + encodeURIComponent(site.id);
  const since = state && state.since;
  const open = since ? `The alert was open for about ${duration(now - since)}. ` : '';
  const rows = [['Site', name], ['Address', site.url]].concat(since ? [['Alert opened', moment(since)]] : [], [['Alert closed', moment(now)]]);
  const words = {
    down: { subject: `Back up: ${host}`, badge: 'Back up', title: `${name} is back up`, lead: `${host} answers again. ${open}Nothing to do now.` },
    ssl: (() => {
      const exp = site.status && site.status.sslExpiresAt;
      return { subject: `SSL renewed: ${host}`, badge: 'Renewed', title: `The SSL certificate on ${name} was renewed`, lead: `${exp && exp > now ? `It is valid until ${day(exp)}. ` : 'The check no longer shows an expiry within 14 days. '}Nothing to do now.` };
    })(),
    unpublished: { subject: `Published: ${host}`, badge: 'Published', title: `${name} was published`, lead: `The waiting changes are live now. Nothing to do.` },
    forms_silent: { subject: `Forms active again: ${host}`, badge: 'Forms active', title: `${name} is receiving form submissions again`, lead: `A new submission arrived, so the form works. Nothing to do.` }
  }[type] || { subject: `Resolved: ${host}`, badge: 'Resolved', title: `${name} is fine again`, lead: 'Nothing to do.' };
  const out = render({
    subject: words.subject,
    badge: ['ok', words.badge],
    title: words.title,
    lead: words.lead,
    button: { href: page, label: 'Open in Flowdeck' },
    sections: [{ heading: 'Details', rows }],
    footer: alertFooter(opts.to)
  });
  return Object.assign(out, { title: words.title, lead: words.lead });
}

/* ---------- weekly report ---------- */

function digest(user, sites, now, opts) {
  now = now || Date.now();
  opts = opts || {};
  const to = opts.to || (user && user.settings && (user.settings.alertEmail || user.email)) || '';
  const items = att.rank(sites, now);
  const n = sites.length;
  const flagged = sites.filter((s) => att.siteItems(s, now).length).length;
  const anyBad = items.some((i) => i.sev === 'bad');
  const down = sites.filter((s) => s.status && s.status.up === false).length;
  const subject = flagged
    ? (n === 1 ? 'Weekly report: your site needs attention' : `Weekly report: ${flagged} of ${n} sites need attention`)
    : (n === 1 ? 'Weekly report: your site is fine' : `Weekly report: all ${n} sites are fine`);
  const title = flagged ? (n === 1 ? 'Your site needs attention' : `${flagged} of ${n} sites need attention`) : (n === 1 ? 'Your site is fine' : `All ${n} sites are fine`);
  const leadText = items.length
    ? `${att.headline(items[0])}${items.length > 1 ? `, and ${plural(items.length - 1, 'more item')} ${items.length === 2 ? 'needs' : 'need'} a look` : ''}. Start at the top of the list below.`
    : 'Every site was up, published and inside its limits this week. Nothing to do.';
  const page = (s, hash) => appUrl() + '/app/site?id=' + encodeURIComponent(s.id) + (hash ? '#' + hash : '');

  // Needs attention: the most urgent first
  const TOP = 6;
  const top = items.slice(0, TOP);
  const attHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${top.map((i) => `<tr>
<td valign="top" class="fd-line" style="width:34px;padding:12px 12px 12px 0;border-top:1px solid ${C.line};">${mark(i.sev)}</td>
<td valign="top" class="fd-line" style="padding:12px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:14px;line-height:20px;">
<a class="fd-a" href="${esc(page(i.site))}" target="_blank" style="color:${C.link};font-weight:700;text-decoration:none;">${esc(att.nameOf(i.site))}</a><span class="fd-muted" style="color:${C.muted};">&nbsp; ${esc(att.hostOf(i.site))}</span><br>
<span class="fd-fg" style="color:${C.fg};font-weight:700;">${esc(i.title)}</span><br>
<span class="fd-muted" style="color:${C.muted};font-size:13px;">${esc(i.detail)}</span></td></tr>`).join('')}</table>${items.length > TOP ? small(`And ${plural(items.length - TOP, 'more item')} in ${link(appUrl() + '/app', 'Flowdeck')}.`, 8) : ''}`;
  const attText = top.map((i, k) => `${k + 1}. ${att.nameOf(i.site)} (${att.hostOf(i.site)}): ${i.title}. ${i.detail}`).join('\n') + (items.length > TOP ? `\nAnd ${plural(items.length - TOP, 'more item')} in Flowdeck.` : '');

  // Every site with its week in numbers
  const urgency = new Map(sites.map((s) => [s.id, att.siteScore(s, now)]));
  const ordered = sites.slice().sort((a, b) => (urgency.get(b.id) - urgency.get(a.id)) || att.nameOf(a).localeCompare(att.nameOf(b)));
  const rows = ordered.map((s) => {
    const own = att.siteItems(s, now).sort((a, b) => b.score - a.score);
    const sev = !own.length ? 'ok' : own.some((i) => i.sev === 'bad') ? 'bad' : 'warn';
    const flags = own.length ? own.map((i) => i.short).join(' · ') : 'OK';
    const up7 = checks.summarize(s._checks || [], now - 7 * DAY);
    const forms = s.data && s.data.forms;
    const seo = s.data && s.data.pages ? s.data.pages.issues : null;
    const stats = `Uptime 7d ${up7.uptime == null ? 'no data' : up7.uptime + '%'} · Forms ${forms ? `${forms.total7} this week, ${forms.total30} in 30 days` : 'not synced yet'} · SEO issues ${seo == null ? 'not synced yet' : seo}`;
    return { s, sev, flags, stats };
  });
  const sitesHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows.map((r) => `<tr>
<td valign="top" class="fd-line" style="width:34px;padding:12px 12px 12px 0;border-top:1px solid ${C.line};">${mark(r.sev)}</td>
<td valign="top" class="fd-line" style="padding:12px 0;border-top:1px solid ${C.line};font-family:${FONT};font-size:14px;line-height:20px;">
<a class="fd-a" href="${esc(page(r.s))}" target="_blank" style="color:${C.link};font-weight:700;text-decoration:none;">${esc(att.nameOf(r.s))}</a><span class="fd-muted" style="color:${C.muted};">&nbsp; ${esc(att.hostOf(r.s))}</span><br>
<span class="fd-fg" style="color:${C.fg};font-weight:700;">${esc(r.flags)}</span><br>
<span class="fd-muted" style="color:${C.muted};font-size:13px;">${esc(r.stats)}</span></td></tr>`).join('')}</table>`;
  const sitesText = rows.map((r) => `${att.nameOf(r.s)} (${att.hostOf(r.s)}): ${r.flags}. ${r.stats}.`).join('\n');

  const settings = appUrl() + '/app/settings';
  return render({
    subject,
    badge: flagged ? (down ? ['bad', plural(down, 'site') + ' down'] : anyBad ? ['bad', 'Something is broken'] : ['warn', 'Needs a look']) : ['ok', 'All fine'],
    title,
    lead: leadText,
    button: { href: appUrl() + '/app', label: 'Open Flowdeck' },
    sections: (items.length ? [{ heading: 'Needs attention, most urgent first', html: attHtml, text: attText }] : [])
      .concat([{ heading: n === 1 ? 'Your site' : 'All sites, most urgent first', html: sitesHtml, text: sitesText }]),
    footer: {
      html: `Week ending ${esc(day(now))}. You get this every Monday because the weekly summary is on${to ? ' for ' + esc(to) : ''}. ${link(settings, 'Turn it off in Settings')}.<br>Flowdeck. Not affiliated with Webflow.`,
      text: `Week ending ${day(now)}. You get this every Monday because the weekly summary is on${to ? ' for ' + to : ''}. Turn it off in Settings: ${settings}`
    }
  });
}

/* ---------- sign in ---------- */

function signIn(linkUrl) {
  return render({
    subject: 'Your Flowdeck sign in link',
    title: 'Sign in to Flowdeck',
    lead: 'Press the button to sign in. The link works once and expires in 15 minutes.',
    button: { href: linkUrl, label: 'Sign in to Flowdeck' },
    sections: [{
      heading: 'If the button does not work',
      html: small(`Copy this link into your browser: ${link(linkUrl, linkUrl)}`, 0),
      text: null // the text version already shows the link itself
    }],
    after: small('Did not ask for this? Ignore this email. Nobody can sign in without this link.', 20),
    afterText: 'Did not ask for this? Ignore this email. Nobody can sign in without this link.',
    footer: { html: 'Flowdeck. Not affiliated with Webflow.', text: 'Flowdeck. Not affiliated with Webflow.' }
  });
}

module.exports = { alertOpened, alertResolved, digest, signIn };
