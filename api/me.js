'use strict';

const database = require('../lib/db');
const { requireSession, noStore, respondError } = require('../lib/crypto');
const { getDashboard } = require('../lib/gmail');

module.exports = async function me(req, res) {
  noStore(res);
  if (req.method !== 'GET') return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  try {
    const auth = await requireSession(req, res, database);
    if (!auth) return res.status(401).json({ ok: false, message: 'Connect your Google account to continue.' });
    const dashboard = await getDashboard(auth.session.sub);
    return res.status(200).json({ ...dashboard, csrfToken: auth.session.csrf });
  } catch (error) { return respondError(res, error, 'Could not load settings.'); }
};
