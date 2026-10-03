'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createCspNonce, noStore } = require('../lib/crypto');

const html = fs.readFileSync(path.join(process.cwd(), 'templates', 'index.html'), 'utf8');

module.exports = async function index(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).send('Method not allowed.');
  noStore(res);
  const nonce = createCspNonce();
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const page = html.replace('<script>', `<script nonce="${nonce}">`);
  return req.method === 'HEAD' ? res.status(200).end() : res.status(200).send(page);
};
