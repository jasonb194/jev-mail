'use strict';

const crypto = require('node:crypto');
const database = require('../lib/db');
const { noStore } = require('../lib/crypto');
const { runEnabledUsers } = require('../lib/gmail');

module.exports = async function cron(req, res) {
  noStore(res);
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, message: 'Method not allowed.' });
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expected = process.env.CRON_SECRET || '';
  if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return res.status(401).json({ ok: false, message: 'Unauthorized.' });
  try {
    await database.ensureSchema();
    const processed = await runEnabledUsers();
    return res.status(200).json({ ok: true, processed: processed.length });
  } catch (_) { return res.status(500).json({ ok: false, message: 'Scheduled run failed.' }); }
};
