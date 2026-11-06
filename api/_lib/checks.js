'use strict';
// Uptime and SSL checks. Pure network code, no storage.
const tls = require('tls');
const net = require('net');
const dns = require('dns').promises;

const UA = 'Mozilla/5.0 (compatible; Flowdeck/1.0; +https://flowdeck.silitlabs.com)';

// Never send a check to a private, loopback or link-local address (a customer could point
// their domain's DNS there). ALLOW_PRIVATE_CHECKS=1 is only for the local test suite.
function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return privateIp(x.slice(7));
    return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb');
  }
  return true;
}
async function publicHost(host) {
  if (process.env.ALLOW_PRIVATE_CHECKS === '1') return true;
  if (net.isIP(host)) return !privateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !privateIp(a.address));
  } catch (e) { return false; }
}

// GET the page. Redirects are followed only while they stay on the same scheme and on one of
// `allowedHosts` (the site's own domains); a redirect anywhere else is not requested and the
// redirect itself counts as the answer.
async function httpCheck(url, timeoutMs, allowedHosts) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    let current = url;
    let res;
    for (let hops = 0; ; hops++) {
      const u = new URL(current);
      if (!(await publicHost(u.hostname.replace(/^\[|\]$/g, '')))) return { t: Date.now(), ok: false, code: 0, ms: Date.now() - started, error: 'blocked address' };
      res = await fetch(current, { method: 'GET', redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html' } });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc || hops >= 5) break;
      let next;
      try { next = new URL(loc, current); } catch (e) { break; }
      const hostKey = (next.port ? next.hostname + ':' + next.port : next.hostname).toLowerCase();
      if (next.protocol !== u.protocol || next.username || next.password || !(allowedHosts || []).includes(hostKey)) break;
      try { if (res.body) await res.body.cancel(); } catch (e) { /* ignore */ }
      current = next.href;
    }
    const ms = Date.now() - started;
    // Some hosts reject GET from bots with 403/405 but are fine; treat 5xx and 404 on the home page as down.
    const ok = res.status < 500 && res.status !== 404 && res.status !== 410;
    return { t: Date.now(), ok, code: res.status, ms };
  } catch (e) {
    return { t: Date.now(), ok: false, code: 0, ms: Date.now() - started, error: e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function sslCheck(host, timeoutMs) {
  if (!(await publicHost(host))) return { ok: false, expiresAt: null, error: 'blocked address' };
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let socket;
    try {
      socket = tls.connect({ host, port: 443, servername: host, timeout: timeoutMs || 8000, rejectUnauthorized: false }, () => {
        const cert = socket.getPeerCertificate();
        const validTo = cert && cert.valid_to ? Date.parse(cert.valid_to) : null;
        const authorized = socket.authorized;
        const err = socket.authorizationError ? String(socket.authorizationError) : '';
        socket.end();
        finish({ ok: !!validTo && authorized, expiresAt: validTo, error: authorized ? '' : err });
      });
      socket.on('timeout', () => { socket.destroy(); finish({ ok: false, expiresAt: null, error: 'timeout' }); });
      socket.on('error', (e) => finish({ ok: false, expiresAt: null, error: e.code || e.message }));
    } catch (e) {
      finish({ ok: false, expiresAt: null, error: e.message });
    }
  });
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

// The only hosts Flowdeck will request for a site: its Webflow subdomain and its custom domains,
// as reported by the Webflow API. A user-entered "URL to check" must be on one of them (allowlist).
function siteHosts(site) {
  const out = new Set();
  const add = (h) => { h = String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); if (h) out.add(h); };
  (site.domains || []).forEach(add);
  if (site.shortName) add(site.shortName + '.webflow.io');
  try { if (site.url) add(new URL(site.url).host); } catch (e) { /* no primary url */ }
  return [...out];
}
function allowedCheckUrl(site, url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return false; }
  const scheme = (process.env.SITE_URL_SCHEME || 'https') + ':';
  if (u.protocol !== scheme || u.username || u.password) return false;
  const host = u.port ? u.hostname + ':' + u.port : u.hostname;
  return siteHosts(site).includes(host.toLowerCase());
}
// URL used for uptime checks: the saved one if it is still on the site's domains, else the primary domain.
function checkUrlOf(site) {
  const custom = site.settings && site.settings.checkUrl;
  return custom && allowedCheckUrl(site, custom) ? custom : site.url;
}

function summarize(checks, sinceMs) {
  const list = sinceMs ? checks.filter((c) => c.t >= sinceMs) : checks;
  const total = list.length;
  const okCount = list.filter((c) => c.ok).length;
  const avgMs = total ? Math.round(list.reduce((a, c) => a + (c.ms || 0), 0) / total) : null;
  return { total, okCount, uptime: total ? Math.round((okCount / total) * 1000) / 10 : null, avgMs };
}

// Daily totals kept on the site record (no extra database calls): { 'YYYY-MM-DD': [ok, total, msSum] }.
// Every single check is kept for 7 days; these totals give honest 30-day figures.
function addDaily(status, check) {
  const day = new Date(check.t).toISOString().slice(0, 10);
  const daily = status.daily || {};
  const d = daily[day] || [0, 0, 0];
  d[0] += check.ok ? 1 : 0;
  d[1] += 1;
  d[2] += check.ms || 0;
  daily[day] = d;
  const days = Object.keys(daily).sort();
  while (days.length > 31) delete daily[days.shift()];
  status.daily = daily;
  return status;
}
function summarizeDaily(daily, sinceMs) {
  const from = new Date(sinceMs).toISOString().slice(0, 10);
  let ok = 0, total = 0, ms = 0;
  for (const [day, d] of Object.entries(daily || {})) if (day >= from) { ok += d[0]; total += d[1]; ms += d[2]; }
  return { total, okCount: ok, uptime: total ? Math.round((ok / total) * 1000) / 10 : null, avgMs: total ? Math.round(ms / total) : null };
}

module.exports = { httpCheck, sslCheck, hostOf, summarize, summarizeDaily, addDaily, siteHosts, allowedCheckUrl, checkUrlOf, privateIp };
