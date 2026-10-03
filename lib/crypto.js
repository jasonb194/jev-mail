'use strict';

const crypto = require('node:crypto');
const SESSION_COOKIE = 'jev_session';
const OAUTH_STATE_COOKIE = 'jev_oauth_state';
const SESSION_SECONDS = 60 * 60 * 24 * 30;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function encryptionKey() {
  const value = required('TOKEN_ENCRYPTION_KEY');
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hexadecimal characters.');
  return Buffer.from(value, 'hex');
}

function encryptSecret(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptSecret(value) {
  if (!value) return null;
  const parts = String(value).split('.');
  if (parts.length !== 3) throw new Error('Encrypted secret has an invalid format.');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error('Encrypted secret has an invalid format.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function sessionSecret() {
  const secret = required('SESSION_SECRET');
  if (Buffer.byteLength(secret) < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest();
}

function createSession(user, now = Date.now()) {
  if (!user || typeof user.sub !== 'string' || !user.sub) throw new Error('Google account identity is invalid.');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: user.sub, email: user.email, csrf, exp: Math.floor(now / 1000) + SESSION_SECONDS })).toString('base64url');
  return { token: `${payload}.${sign(payload).toString('base64url')}`, csrf };
}

function verifySession(token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const actual = Buffer.from(signature, 'base64url');
  const expected = sign(payload);
  if (actual.toString('base64url') !== signature || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!session || typeof session.sub !== 'string' || typeof session.csrf !== 'string' || !Number.isInteger(session.exp) || session.exp <= Math.floor(now / 1000)) return null;
    return session;
  } catch (_) { return null; }
}

function parseCookies(header) {
  const cookies = Object.create(null);
  String(header || '').split(';').forEach((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return;
    try { cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim()); } catch (_) {}
  });
  return cookies;
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`, 'SameSite=Lax'];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(name, path = '/') { return cookie(name, '', { path, maxAge: 0 }); }

function createOAuthState() {
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { state, verifier, stateHash: crypto.createHash('sha256').update(state).digest('hex'), challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

function safeReturnTo(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/';
}

function requestIsSameOrigin(req) {
  if (!req.headers.origin) return false;
  try { return new URL(req.headers.origin).origin === new URL(process.env.APP_URL || `https://${req.headers.host}`).origin; }
  catch (_) { return false; }
}

function appBaseUrl() {
  const parsed = new URL(required('APP_URL'));
  if (parsed.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && parsed.hostname === 'localhost')) throw new Error('APP_URL must use HTTPS.');
  return parsed.origin;
}

function oauthRedirectUri() { return new URL('/api/auth/callback', appBaseUrl()).toString(); }
function oauthConfiguration() { return { clientId: required('GOOGLE_CLIENT_ID'), clientSecret: required('GOOGLE_CLIENT_SECRET'), redirectUri: oauthRedirectUri() }; }

function appendSetCookie(res, value) {
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', current ? (Array.isArray(current) ? current.concat(value) : [current, value]) : value);
}

function redirect(res, location) { res.statusCode = 303; res.setHeader('Location', location); res.end(); }

async function parseJsonBody(req, maxBytes = 131072) {
  if (req.body !== undefined) {
    if (req.body !== null && typeof req.body === 'object') {
      if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > maxBytes) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
      return req.body;
    }
    if (typeof req.body === 'string') {
      if (Buffer.byteLength(req.body, 'utf8') > maxBytes) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
      try { return JSON.parse(req.body); }
      catch (_) { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }); }
    }
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (_) { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }); }
}

async function requireSession(req, res, database) {
  const session = verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!session) { if (res) res.setHeader('WWW-Authenticate', 'Session'); return null; }
  const user = await database.userById(session.sub);
  return user && user.refreshToken ? { session, user } : null;
}

function csrfFromRequest(req, session) {
  const supplied = req.headers['x-csrf-token'] || (req.body && req.body.csrfToken);
  if (!session || !requestIsSameOrigin(req) || typeof supplied !== 'string') return false;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(session.csrf);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function revokeGoogleToken(token) {
  if (!token) return;
  try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }); } catch (_) {}
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function respondError(res, error, fallback = 'Request failed.') {
  const status = Number.isInteger(error && error.statusCode) ? error.statusCode : 500;
  res.status(status).json({ ok: false, message: status < 500 ? error.message : fallback });
}

function createCspNonce() {
  return crypto.randomBytes(18).toString('base64');
}

function contentSecurityPolicy(res, nonce = createCspNonce()) {
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  return nonce;
}

function sessionFromRequest(req) { return verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]); }

module.exports = {
  SESSION_COOKIE, OAUTH_STATE_COOKIE, SESSION_SECONDS, encryptSecret, decryptSecret,
  createSession, verifySession, parseCookies, cookie, clearCookie, createOAuthState,
  safeReturnTo, appBaseUrl, oauthRedirectUri, oauthConfiguration, appendSetCookie,
  redirect, parseJsonBody, requireSession, revokeGoogleToken, noStore,
  respondError, csrfFromRequest, sessionFromRequest, contentSecurityPolicy, createCspNonce,
};
