'use strict';
const crypto = require('crypto');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function key() {
  const secret = process.env.SESSION_SECRET || '';
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return crypto.createHash('sha256').update(secret).digest();
}
// AES-256-GCM, output iv.ciphertext.tag in base64url
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return b64url(iv) + '.' + b64url(data) + '.' + b64url(cipher.getAuthTag());
}
function open(token) {
  try {
    const [iv, data, tag] = String(token).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), fromB64url(iv));
    decipher.setAuthTag(fromB64url(tag));
    const out = Buffer.concat([decipher.update(fromB64url(data)), decipher.final()]).toString('utf8');
    return JSON.parse(out);
  } catch (e) {
    return null;
  }
}
function random(bytes) { return b64url(crypto.randomBytes(bytes || 16)); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function timingEqual(a, b) {
  const A = Buffer.from(String(a)); const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

module.exports = { seal, open, random, sha256, timingEqual, b64url };
