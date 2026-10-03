'use strict';

const database = require('../../lib/db');
const { OAUTH_STATE_COOKIE, cookie, appendSetCookie, createOAuthState, oauthConfiguration, safeReturnTo, redirect, noStore, respondError } = require('../../lib/crypto');

module.exports = async function login(req, res) {
  noStore(res);
  if (req.method !== 'GET') return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  try {
    const config = oauthConfiguration();
    const oauth = createOAuthState();
    const redirectTo = safeReturnTo(typeof req.query.returnTo === 'string' ? req.query.returnTo : '/');
    await database.putOAuthState(oauth.stateHash, JSON.stringify({ verifier: oauth.verifier, returnTo: redirectTo }));
    appendSetCookie(res, cookie(OAUTH_STATE_COOKIE, oauth.state, { path: '/api/auth', maxAge: 600 }));
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: 'openid email https://www.googleapis.com/auth/gmail.modify', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: oauth.state, code_challenge: oauth.challenge, code_challenge_method: 'S256' }).toString();
    return redirect(res, url.toString());
  } catch (error) { return respondError(res, error, 'Could not start Google authorization.'); }
};
