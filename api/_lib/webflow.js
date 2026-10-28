'use strict';
// Minimal Webflow Data API v2 client with 429 backoff.

const API_BASE = () => (process.env.WEBFLOW_API_BASE || 'https://api.webflow.com').replace(/\/+$/, '');
const AUTH_BASE = () => (process.env.WEBFLOW_AUTH_BASE || 'https://webflow.com').replace(/\/+$/, '');

const SCOPES = ['authorized_user:read', 'sites:read', 'pages:read', 'cms:read', 'forms:read'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(token, method, path, body, attempt) {
  attempt = attempt || 0;
  const res = await fetch(API_BASE() + '/v2' + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 429 && attempt < 2) {
    const wait = parseInt(res.headers.get('retry-after') || '0', 10) * 1000 || (attempt + 1) * 3000;
    await sleep(Math.min(wait, 10000));
    return call(token, method, path, body, attempt + 1);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.msg || data.error)) || ('Webflow API error ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function authorizeUrl({ clientId, redirectUri, state }) {
  return AUTH_BASE() + '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: SCOPES.join(' '), state
  }).toString();
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const res = await fetch(API_BASE() + '/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error((data && (data.error_description || data.message || data.error)) || 'Token exchange failed');
  }
  return data.access_token;
}

const authorizedBy = (token) => call(token, 'GET', '/token/authorized_by');
const listSites = async (token) => ((await call(token, 'GET', '/sites')) || {}).sites || [];
const getSite = (token, siteId) => call(token, 'GET', '/sites/' + siteId);

async function listPages(token, siteId, max) {
  const pages = [];
  let offset = 0;
  while (pages.length < (max || 500)) {
    const data = await call(token, 'GET', `/sites/${siteId}/pages?limit=100&offset=${offset}`);
    const batch = (data && data.pages) || [];
    pages.push(...batch);
    const total = data && data.pagination ? data.pagination.total : batch.length;
    offset += batch.length;
    if (!batch.length || offset >= total) break;
  }
  return pages;
}

async function listCollections(token, siteId) {
  const data = await call(token, 'GET', `/sites/${siteId}/collections`);
  return (data && data.collections) || [];
}

async function countItems(token, collectionId) {
  const data = await call(token, 'GET', `/collections/${collectionId}/items?limit=1`);
  if (data && data.pagination && typeof data.pagination.total === 'number') return data.pagination.total;
  return ((data && data.items) || []).length;
}

// Submissions newer than `since` (ms), newest first, capped.
async function listSubmissions(token, siteId, since, max) {
  const out = [];
  let offset = 0;
  while (out.length < (max || 500)) {
    const data = await call(token, 'GET', `/sites/${siteId}/form_submissions?limit=100&offset=${offset}`);
    const batch = (data && data.formSubmissions) || [];
    if (!batch.length) break;
    let stop = false;
    for (const s of batch) {
      const t = Date.parse(s.dateSubmitted || 0) || 0;
      if (t < since) { stop = true; continue; }
      out.push({ id: s.id, form: s.displayName || 'Form', at: t, formId: s.formId || s.formElementId || '' });
    }
    const total = data && data.pagination ? data.pagination.total : batch.length;
    offset += batch.length;
    if (stop || offset >= total) break;
  }
  return out;
}

module.exports = { SCOPES, call, authorizeUrl, exchangeCode, authorizedBy, listSites, getSite, listPages, listCollections, countItems, listSubmissions };
