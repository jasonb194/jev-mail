'use strict';

const database = require('../lib/db');
const { requireSession, csrfFromRequest, parseJsonBody, noStore, respondError } = require('../lib/crypto');
const { saveSettings } = require('../lib/gmail');

module.exports = async function settings(req, res) {
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  try {
    const auth = await requireSession(req, res, database);
    if (!auth) return res.status(401).json({ ok: false, message: 'Connect your Google account to continue.' });
    const body = await parseJsonBody(req, 32768);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['expectedRevision', 'settings', 'apiKeyAction', 'apiKey'].includes(key))) return res.status(400).json({ ok: false, message: 'Request body contains unsupported fields.' });
    if (!csrfFromRequest(req, auth.session)) return res.status(403).json({ ok: false, message: 'Request could not be verified.' });
    const result = await saveSettings(auth.session.sub, auth.user.email, body);
    return res.status(200).json(result);
  } catch (error) { return respondError(res, error, 'Could not save settings.'); }
};
