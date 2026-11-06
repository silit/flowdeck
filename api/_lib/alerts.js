'use strict';
// Alert rules. Each rule is evaluated per site; state lives in kv so an email goes out once
// when a problem starts and once when it ends.
const store = require('./store');
const email = require('./email');
const { unpublishedDays, DAY } = require('./sync');

const RULES = {
  down: {
    title: (s) => `${s.name} is down`,
    body: (s, d) => `${s.url} failed ${d.fails} checks in a row (last status ${d.code || 'no response'}${d.error ? ', ' + d.error : ''}).`,
    recovered: (s) => `${s.name} is back up`
  },
  ssl: {
    title: (s, d) => `SSL certificate on ${s.name} expires in ${d.days} days`,
    body: (s, d) => `The certificate for ${s.url} expires on ${new Date(d.expiresAt).toUTCString()}. Webflow renews automatically for Webflow-hosted domains; check DNS if this keeps showing.`,
    recovered: (s) => `SSL certificate on ${s.name} renewed`
  },
  unpublished: {
    title: (s, d) => `${s.name} has unpublished changes for ${d.days} days`,
    body: (s) => `Changes in the Designer have not been published since ${s.lastPublished ? new Date(s.lastPublished).toUTCString() : 'never'}. Publish the site or discard the changes.`,
    recovered: (s) => `${s.name} was published`
  },
  forms_silent: {
    title: (s) => `No form submissions on ${s.name} for 30 days`,
    body: (s, d) => `${s.name} received ${d.before} submissions in the 30 days before that, and none since. Check that the form still works and notifications still arrive.`,
    recovered: (s) => `${s.name} is receiving form submissions again`
  }
};

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
    const rule = RULES[type];
    const state = states[type];
    const active = !!found[type];
    const fail = fails[type];
    if (!active && fail) await store.clearAlertFail(site.id, type); // problem over: forget old failures
    if (active && !state) {
      const t = now || Date.now();
      if (to) {
        if (fail && fail.until > t) { sent.push({ type, state: 'waiting' }); continue; }
        const subject = rule.title(site, found[type]);
        const body = rule.body(site, found[type]);
        try {
          await email.send({ to, subject: '[Flowdeck] ' + subject, text: body + '\n\nOpen Flowdeck: ' + appUrl() + '/app/site?id=' + site.id, html: `<p>${esc(body)}</p><p><a href="${appUrl()}/app/site?id=${site.id}">Open in Flowdeck</a></p>` });
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
          await email.send({ to, subject: '[Flowdeck] ' + rule.recovered(site), text: rule.recovered(site) + '.', html: `<p>${esc(rule.recovered(site))}.</p>` });
        } catch (e) { console.error('[alert email]', e.message); }
      }
      sent.push({ type, state: 'closed' });
    }
  }
  return sent;
}

function appUrl() { return (process.env.APP_URL || '').replace(/\/+$/, ''); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

module.exports = { RULES, evaluate, process: processSite };
