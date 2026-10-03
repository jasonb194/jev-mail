'use strict';

const database = require('../lib/db');
const { requireSession, csrfFromRequest, parseJsonBody, noStore, respondError } = require('../lib/crypto');
const { runNow } = require('../lib/gmail');

module.exports = async function run(req, res) {
  noStore(res);
  if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  try {
    const auth = await requireSession(req, res, database);
    if (!auth) return res.status(401).json({ ok: false, message: 'Connect your Google account to continue.' });
    const body = await parseJsonBody(req, 2048);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'csrfToken')) return res.status(400).json({ ok: false, message: 'Request body contains unsupported fields.' });
    if (!csrfFromRequest(req, auth.session)) return res.status(403).json({ ok: false, message: 'Request could not be verified.' });
    return res.status(200).json({ ok: true, summary: await runNow(auth.session.sub) });
  } catch (error) { return respondError(res, error, 'Gmail processing failed.'); }
};
