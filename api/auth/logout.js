'use strict';

const database = require('../../lib/db');
const { SESSION_COOKIE, parseCookies, verifySession, csrfFromRequest, revokeGoogleToken, decryptSecret, clearCookie, appendSetCookie, noStore } = require('../../lib/crypto');

module.exports = async function logout(req, res) {
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  try {
    const session = verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!session) return res.status(401).json({ ok: false, message: 'Sign in with Google first.' });
    if (!csrfFromRequest(req, session)) return res.status(403).json({ ok: false, message: 'Request could not be verified.' });
    const user = await database.userById(session.sub);
    if (user?.refreshToken) await revokeGoogleToken(decryptSecret(user.refreshToken));
    await database.disconnectUser(session.sub);
    appendSetCookie(res, clearCookie(SESSION_COOKIE));
    return res.status(200).json({ ok: true });
  } catch (_) { return res.status(500).json({ ok: false, message: 'Could not disconnect Google.' }); }
};
