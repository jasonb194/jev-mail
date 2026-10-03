'use strict';

const database = require('../../lib/db');
const { createDefaultSettings } = require('../../lib/settings');
const { encryptSecret, OAUTH_STATE_COOKIE, SESSION_COOKIE, SESSION_SECONDS, cookie, clearCookie, appendSetCookie, parseCookies, createSession, oauthConfiguration, redirect, noStore, respondError } = require('../../lib/crypto');

module.exports = async function callback(req, res) {
  noStore(res);
  if (req.method !== 'GET') return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  let temporaryRefreshToken;
  try {
    const cookies = parseCookies(req.headers.cookie);
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const cookieState = cookies[OAUTH_STATE_COOKIE] || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(cookieState)) throw Object.assign(new Error('Google authorization could not be verified. Start again.'), { statusCode: 400 });
    if (!require('node:crypto').timingSafeEqual(Buffer.from(state), Buffer.from(cookieState))) throw Object.assign(new Error('Google authorization could not be verified. Start again.'), { statusCode: 400 });
    const crypto = require('node:crypto');
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    const savedState = await database.takeOAuthState(stateHash);
    if (!savedState || typeof savedState.verifier !== 'string') {
      appendSetCookie(res, clearCookie(OAUTH_STATE_COOKIE, '/api/auth'));
      const failure = new Error('Google authorization expired. Start again.');
      failure.statusCode = 400;
      return respondError(res, failure, 'Google authorization failed.');
    }
    if (req.query.error) {
      const failure = new Error('Google authorization was not granted.');
      failure.statusCode = 400;
      failure.returnTo = savedState.returnTo;
      throw failure;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code) throw Object.assign(new Error('Google did not return an authorization code.'), { statusCode: 400 });
    const config = oauthConfiguration();
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: savedState.verifier }) });
    const tokens = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || typeof tokens.access_token !== 'string') throw Object.assign(new Error('Could not exchange Google authorization.'), { statusCode: 502 });
    temporaryRefreshToken = tokens.refresh_token;
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const profile = await profileResponse.json().catch(() => ({}));
    if (!profileResponse.ok || typeof profile.sub !== 'string' || typeof profile.email !== 'string' || profile.email_verified !== true) throw Object.assign(new Error('Could not verify the Google account.'), { statusCode: 502 });
    const prior = await database.userById(profile.sub);
    if (!tokens.refresh_token && !prior?.refreshToken) {
      const failure = new Error('Google did not grant offline access. Reconnect and approve access.');
      failure.statusCode = 400;
      failure.returnTo = savedState.returnTo;
      throw failure;
    }
    await database.upsertUser({ subject: profile.sub, email: profile.email, settings: prior ? prior.settings : createDefaultSettings(), refreshToken: tokens.refresh_token ? encryptSecret(tokens.refresh_token) : null });
    temporaryRefreshToken = null;
    const session = createSession({ sub: profile.sub, email: profile.email });
    appendSetCookie(res, cookie(SESSION_COOKIE, session.token, { maxAge: SESSION_SECONDS }));
    appendSetCookie(res, clearCookie(OAUTH_STATE_COOKIE, '/api/auth'));
    const destination = savedState.returnTo === '/settings' ? '/settings' : '/';
    return redirect(res, destination);
  } catch (error) {
    if (temporaryRefreshToken) {
      const body = new URLSearchParams({ token: temporaryRefreshToken });
      try { await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }); } catch (_) {}
    }
    appendSetCookie(res, clearCookie(OAUTH_STATE_COOKIE, '/api/auth'));
    if (!error.returnTo && req.query.error) {
      appendSetCookie(res, cookie('jev_oauth_error', 'authorization_failed', { path: '/', maxAge: 60, httpOnly: false }));
      return redirect(res, '/');
    }
    if (error.returnTo === '/' || error.returnTo === '/settings') {
      appendSetCookie(res, cookie('jev_oauth_error', 'authorization_failed', { path: '/', maxAge: 60, httpOnly: false }));
      return redirect(res, error.returnTo);
    }
    return respondError(res, error, 'Google authorization failed.');
  }
};
