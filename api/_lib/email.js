'use strict';
// Email via Resend. When RESEND_API_KEY is missing the message is logged and dropped.

function enabled() { return !!process.env.RESEND_API_KEY; }

async function send({ to, subject, html, text }) {
  const from = process.env.EMAIL_FROM || 'Flowdeck <alerts@flowdeck.app>';
  if (!process.env.RESEND_API_KEY) {
    console.log('[email skipped]', to, subject);
    return { skipped: true };
  }
  const base = (process.env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/+$/, '');
  const res = await fetch(base + '/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, text })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Email failed: ' + (data.message || res.status));
  return data;
}

module.exports = { enabled, send };
