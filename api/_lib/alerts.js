'use strict';
// Alert rules. Each rule is evaluated per site; state lives in kv so an email goes out once
// when a problem starts and once when it ends.
const store = require('./store');
const email = require('./email');
const emails = require('./emails');
const { unpublishedDays, DAY } = require('./sync');

// The rule types. The words of each email (subject, first line, button, details) live in emails.js;
// these keep their old shape for anything that reads them: subject line, first line, recovery subject.
const RULES = {};
for (const type of ['down', 'ssl', 'unpublished', 'forms_silent']) {
  RULES[type] = {
    title: (s, d) => emails.alertOpened(s, type, d).subject,
    body: (s, d) => emails.alertOpened(s, type, d).lead,
    recovered: (s, state) => emails.alertResolved(s, type, state).subject
  };
}

function evaluate(site, now) {
  now = now || Date.now();
  const found = {};
  const st = site.status || {};
  if (st.fails >= 2) found.down = { fails: st.fails, code: st.code, error: st.error || '' };
  if (st.sslExpiresAt) {
    const days = Math.floor((st.sslExpiresAt - now) / DAY);
    if (days <= 14) found.ssl = { days, expiresAt: st.sslExpiresAt };
  }
  const ud = unpublishedDays(site, now);
  if (ud != null && ud >= 7) found.unpublished = { days: ud };
  const f = site.data && site.data.forms;
  if (f && f.total30 === 0 && f.before30 > 0) found.forms_silent = { before: f.before30 };
  return found;
}

// `types` limits which rules this run owns: the checks job evaluates down and ssl (data it just
// measured), the sync job unpublished and forms_silent, so neither can close the other's alert
// from a stale copy of the site.
async function processSite(site, user, now, types) {
  if (!site.settings || site.settings.alerts === false) return [];
  if (!user || !user.settings || user.settings.alerts === false) return [];
  const to = (user.settings.alertEmail || user.email || '').trim();
  const found = evaluate(site, now);
  const sent = [];
  const own = (types || Object.keys(RULES)).filter((t) => RULES[t]);
  const { states, fails } = await store.getAlertStates(site.id, own); // one read for all rules
  for (const type of own) {
    const state = states[type];
    const active = !!found[type];
    const fail = fails[type];
    if (!active && fail) await store.clearAlertFail(site.id, type); // problem over: forget old failures
    if (active && !state) {
      const t = now || Date.now();
      if (to) {
        if (fail && fail.until > t) { sent.push({ type, state: 'waiting' }); continue; }
        try {
          const msg = emails.alertOpened(site, type, found[type], { now: t, to });
          await email.send({ to, subject: msg.subject, html: msg.html, text: msg.text });
        } catch (e) {
          // Not recorded as sent, so a failed email never hides an outage. A temporary problem
          // (rate limit, server error, network) is retried on the next run; an email the service
          // refuses (bad address, unverified sender) backs off: 5, 10, 20 minutes ... up to 6 hours.
          console.error('[alert email]', e.message);
          const lasting = e.status >= 400 && e.status < 500 && e.status !== 429;
          if (lasting) {
            const n = (fail ? fail.n : 0) + 1;
            await store.setAlertFail(site.id, type, { n, until: t + Math.min(6 * 3600000, 300000 * Math.pow(2, n - 1)), error: String(e.message).slice(0, 120) });
          }
          sent.push({ type, state: 'retry' });
          continue;
        }
      }
      await store.setAlert(site.id, type, { since: t, detail: found[type] });
      if (fail) await store.clearAlertFail(site.id, type);
      sent.push({ type, state: 'opened' });
    } else if (!active && state) {
      await store.clearAlert(site.id, type);
      if (to) {
        try {
          const msg = emails.alertResolved(site, type, state, { now: now || Date.now(), to });
          await email.send({ to, subject: msg.subject, html: msg.html, text: msg.text });
        } catch (e) { console.error('[alert email]', e.message); }
      }
      sent.push({ type, state: 'closed' });
    }
  }
  return sent;
}

module.exports = { RULES, evaluate, process: processSite };
