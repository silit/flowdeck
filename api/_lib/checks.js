'use strict';
// Uptime and SSL checks. Pure network code, no storage.
const tls = require('tls');

const UA = 'Mozilla/5.0 (compatible; Flowdeck/1.0; +https://flowdeck.silitlabs.com)';

async function httpCheck(url, timeoutMs) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    let res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html' } });
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

function sslCheck(host, timeoutMs) {
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

function summarize(checks, sinceMs) {
  const list = sinceMs ? checks.filter((c) => c.t >= sinceMs) : checks;
  const total = list.length;
  const okCount = list.filter((c) => c.ok).length;
  const avgMs = total ? Math.round(list.reduce((a, c) => a + (c.ms || 0), 0) / total) : null;
  return { total, okCount, uptime: total ? Math.round((okCount / total) * 1000) / 10 : null, avgMs };
}

module.exports = { httpCheck, sslCheck, hostOf, summarize };
