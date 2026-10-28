'use strict';
// Upstash Redis REST client (works with Vercel's KV_REST_API_* names and Upstash's own).
// Every value we store is JSON. Commands are pipelined where it helps.

function config() {
  let url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  let token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  if (!url || !token) {
    // The Vercel marketplace integration names the variables after a custom prefix, e.g. STORAGE_REST_API_URL
    for (const k of Object.keys(process.env)) {
      if (!url && /_REST_API_URL$/.test(k) && process.env[k]) url = process.env[k];
      if (!token && /_REST_API_TOKEN$/.test(k) && !/READ_ONLY/.test(k) && process.env[k]) token = process.env[k];
    }
  }
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

function enabled() { return !!config(); }

async function command(...parts) {
  const cfg = config();
  if (!cfg) throw new Error('Database is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)');
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(parts.map((p) => (typeof p === 'string' ? p : String(p))))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error('KV error: ' + (data.error || res.status));
  return data.result;
}

async function pipeline(commands) {
  const cfg = config();
  if (!cfg) throw new Error('Database is not configured');
  const res = await fetch(cfg.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands.map((c) => c.map((p) => (typeof p === 'string' ? p : String(p)))))
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) throw new Error('KV pipeline error: ' + res.status);
  return data.map((r) => (r && r.error ? null : r.result));
}

const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return null; } };

async function getJSON(key) { return parse(await command('GET', key)); }
async function mgetJSON(keys) {
  if (!keys.length) return [];
  const out = await command('MGET', ...keys);
  return (out || []).map(parse);
}
async function setJSON(key, value, ttl) {
  const args = ['SET', key, JSON.stringify(value)];
  if (ttl) args.push('EX', String(ttl));
  return command(...args);
}
async function del(...keys) { return keys.length ? command('DEL', ...keys) : 0; }
async function setNX(key, value, ttl) {
  const args = ['SET', key, JSON.stringify(value), 'NX'];
  if (ttl) args.push('EX', String(ttl));
  return (await command(...args)) === 'OK';
}
async function sadd(key, ...members) { return members.length ? command('SADD', key, ...members) : 0; }
async function srem(key, ...members) { return members.length ? command('SREM', key, ...members) : 0; }
async function smembers(key) { return (await command('SMEMBERS', key)) || []; }
async function lpushJSON(key, value, keep) {
  await command('LPUSH', key, JSON.stringify(value));
  if (keep) await command('LTRIM', key, '0', String(keep - 1));
}
async function lrangeJSON(key, count) {
  const items = await command('LRANGE', key, '0', String((count || 100) - 1));
  return (items || []).map(parse).filter((x) => x != null);
}
async function incr(key) { return command('INCR', key); }
async function expire(key, ttl) { return command('EXPIRE', key, String(ttl)); }

module.exports = { enabled, command, pipeline, getJSON, mgetJSON, setJSON, del, setNX, sadd, srem, smembers, lpushJSON, lrangeJSON, incr, expire };
