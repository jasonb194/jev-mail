'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const { createDefaultSettings, validateSettings, isValidJevApiUrl } = require('../lib/settings');
const { createOAuthState, createSession, verifySession, encryptSecret, decryptSecret } = require('../lib/crypto');
const { extractThread, classificationSize, fitThreadToLimits, isPublicAddress } = require('../lib/gmail');

let environmentQueue = Promise.resolve();
async function withEnvironment(values, callback) {
  const previousTask = environmentQueue;
  let release;
  environmentQueue = new Promise((resolve) => { release = resolve; });
  await previousTask;
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return await callback(); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    release();
  }
}

test('default settings validate and are returned as independent values', () => {
  const first = createDefaultSettings();
  const second = createDefaultSettings();
  first.categories[0].label = 'Changed';
  assert.notEqual(second.categories[0].label, 'Changed');
  assert.equal(validateSettings(second).enabled, false);
  assert.equal(second.categories.length, 9);
});

test('provider URLs require HTTPS and reject credentials and fragments', () => {
  assert.equal(isValidJevApiUrl('https://provider.example/v1/classify'), true);
  assert.equal(isValidJevApiUrl('https://127.0.0.1/private'), false);
  assert.equal(isValidJevApiUrl('https://[::1]/private'), false);
  assert.equal(isValidJevApiUrl('https://metadata.google.internal/'), false);
  assert.equal(isValidJevApiUrl('http://provider.example/v1'), false);
  assert.equal(isValidJevApiUrl('https://user:secret@provider.example/v1'), false);
  assert.equal(isValidJevApiUrl('https://provider.example/v1#token'), false);
  const settings = createDefaultSettings();
  settings.apiUrl = 'https://user:secret@provider.example/v1';
  assert.throws(() => validateSettings(settings), /HTTPS endpoint/);
});

test('provider DNS addresses must all be public to block private, link-local and IPv6-local targets', () => {
  assert.equal(isPublicAddress('8.8.8.8', 4), true);
  assert.equal(isPublicAddress('192.168.1.10', 4), false);
  assert.equal(isPublicAddress('169.254.169.254', 4), false);
  assert.equal(isPublicAddress('::1', 6), false);
  assert.equal(isPublicAddress('fd00::1', 6), false);
});

test('OAuth state contains independent cryptographic state, verifier and S256 challenge', () => {
  const state = createOAuthState();
  assert.equal(state.state.length, 43);
  assert.equal(state.verifier.length, 43);
  assert.equal(state.challenge, crypto.createHash('sha256').update(state.verifier).digest('base64url'));
  assert.equal(state.stateHash, crypto.createHash('sha256').update(state.state).digest('hex'));
  assert.notEqual(state.state, state.verifier);
});

test('signed sessions reject tampering and expiration', async () => {
  await withEnvironment({ SESSION_SECRET: 's'.repeat(48) }, () => {
    const now = 1_800_000_000_000;
    const session = createSession({ sub: 'google-subject', email: 'person@example.test' }, now);
    assert.equal(verifySession(session.token, now).sub, 'google-subject');
    assert.equal(verifySession(session.token, now + 31 * 24 * 60 * 60 * 1000), null);
    const tampered = session.token.replace(/.$/, session.token.endsWith('a') ? 'b' : 'a');
    assert.equal(verifySession(tampered, now), null);
  });
});

test('AES-GCM secret encryption round-trips and detects modified ciphertext', async () => {
  await withEnvironment({ TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32) }, () => {
    const encrypted = encryptSecret('refresh-token-private');
    assert.notEqual(encrypted, 'refresh-token-private');
    assert.equal(decryptSecret(encrypted), 'refresh-token-private');
    const [iv, tag, body] = encrypted.split('.');
    const changed = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
    assert.throws(() => decryptSecret([iv, tag, changed].join('.')));
  });
});

test('Gmail thread extraction excludes sent, drafts, spam and trash messages', () => {
  const b64 = (value) => Buffer.from(value).toString('base64url');
  const extracted = extractThread({ messages: [
    { id: 'sent', labelIds: ['SENT'], payload: { mimeType: 'text/plain', body: { data: b64('do not include') } } },
    { id: 'eligible', labelIds: ['INBOX'], payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: 'person@example.test' }, { name: 'Subject', value: 'Hello' }], parts: [{ mimeType: 'text/plain', body: { data: b64('Eligible email body') } }] } },
    { id: 'spam', labelIds: ['SPAM'], payload: { mimeType: 'text/plain', body: { data: b64('spam text') } } },
  ] });
  assert.deepEqual(extracted.messageIds, ['eligible']);
  assert.deepEqual(extracted.state.messages, [{ sender: 'person@example.test', subject: 'Hello', body: 'Eligible email body' }]);
});

test('oversized thread bodies are shortened to fit configured provider limits', () => {
  const settings = createDefaultSettings();
  const item = { threadData: { state: { messages: [{ sender: 'sender@example.test', subject: 'Long mail', body: 'private-content-'.repeat(12000) }] } } };
  assert.equal(fitThreadToLimits(item, settings), true);
  const size = classificationSize([item], settings);
  assert.ok(size.requestTokens <= settings.advanced.maxRequestTokens);
  assert.ok(size.stateQuestionTokens <= settings.advanced.maxStateQuestionTokens);
  assert.match(item.threadData.state.messages[0].body, /\[body truncated\]$/);
  assert.ok(!item.threadData.state.messages[0].body.includes('private-content-'.repeat(12000)));
});

test('classification sizing includes a complete request and named question mappings', () => {
  const settings = createDefaultSettings();
  const item = { threadData: { state: { messages: [{ sender: 'a@example.test', subject: 'subject', body: 'body' }] } } };
  const result = classificationSize([item], settings);
  assert.equal(result.mappings.length, 9);
  assert.ok(result.requestTokens > 0);
  assert.ok(result.stateQuestionTokens > 0);
  assert.equal(result.payload.state.threads.item_000.messages[0].body, 'body');
});

function withModuleMock(modulePath, exports, callback) {
  const resolved = require.resolve(modulePath);
  const original = require.cache[resolved];
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  try { return callback(); }
  finally {
    if (original) require.cache[resolved] = original;
    else delete require.cache[resolved];
  }
}

function responseHarness() {
  return {
    headers: Object.create(null), statusCode: 200, body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    getHeader(name) { return this.headers[name]; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; },
  };
}

test('Google login uses PKCE, an allowlisted return path, and a short-lived state cookie', async () => {
  let stored;
  const database = { async putOAuthState(hash, state) { stored = { hash, value: JSON.parse(state) }; } };
  try {
    await withEnvironment({ APP_URL: 'https://app.example.com', GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret' }, async () => {
      await withModuleMock('../lib/db', database, async () => {
        delete require.cache[require.resolve('../api/auth/login')];
        const login = require('../api/auth/login');
        const res = responseHarness();
        await login({ method: 'GET', query: { returnTo: '//attacker.example' }, headers: {} }, res);
        assert.equal(res.statusCode, 303);
        const authorization = new URL(res.headers.Location);
        assert.equal(authorization.origin, 'https://accounts.google.com');
        assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(authorization.searchParams.get('redirect_uri'), 'https://app.example.com/api/auth/callback');
        assert.equal(stored.value.returnTo, '/');
        assert.equal(stored.hash.length, 64);
        assert.equal(typeof res.headers['Set-Cookie'], 'string');
        assert.match(res.headers['Set-Cookie'], /Path=\/api\/auth/);
        assert.match(res.headers['Set-Cookie'], /Max-Age=600/);
      });
    });
  } finally { delete require.cache[require.resolve('../api/auth/login')]; }
});

test('OAuth callback rejects malformed state before consuming a stored authorization', async () => {
  let consumed = false;
  const database = { async takeOAuthState() { consumed = true; return null; } };
  try {
    await withModuleMock('../lib/db', database, async () => {
      delete require.cache[require.resolve('../api/auth/callback')];
      const callback = require('../api/auth/callback');
      const res = responseHarness();
      await callback({ method: 'GET', headers: { cookie: 'jev_oauth_state=not-valid' }, query: { state: '😀' } }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(consumed, false);
    });
  } finally { delete require.cache[require.resolve('../api/auth/callback')]; }
});

test('settings endpoint enforces signed session and CSRF before saving', async () => {
  await withEnvironment({ SESSION_SECRET: 's'.repeat(48), APP_URL: 'https://app.example.com' }, async () => {
    const session = createSession({ sub: 'account-a', email: 'a@example.test' });
    let saves = 0;
    const database = { async userById(subject) { assert.equal(subject, 'account-a'); return { refreshToken: 'encrypted' }; } };
    const gmail = { async saveSettings() { saves += 1; return { ok: true }; } };
    try {
      await withModuleMock('../lib/db', database, async () => withModuleMock('../lib/gmail', gmail, async () => {
        delete require.cache[require.resolve('../api/settings')];
        const handler = require('../api/settings');
        const request = { method: 'POST', headers: { cookie: `jev_session=${encodeURIComponent(session.token)}`, origin: 'https://app.example.com', 'x-csrf-token': 'wrong' }, body: '{}' };
        const denied = responseHarness();
        await handler(request, denied);
        assert.equal(denied.statusCode, 403);
        assert.equal(saves, 0);
        request.headers['x-csrf-token'] = session.csrf;
        const accepted = responseHarness();
        await handler(request, accepted);
        assert.equal(accepted.statusCode, 200);
        assert.equal(saves, 1);
      }));
    } finally { delete require.cache[require.resolve('../api/settings')]; }
  });
});

test('home page handler injects a CSP nonce before the inline script executes', async () => {
  delete require.cache[require.resolve('../api/index')];
  const handler = require('../api/index');
  const res = responseHarness();
  res.send = function (value) { this.body = value; return this; };
  await handler({ method: 'GET' }, res);
  const policy = res.headers['Content-Security-Policy'];
  const nonce = /nonce-([^']+)/.exec(policy)[1];
  assert.ok(res.body.includes(`<script nonce="${nonce}">`));
  assert.ok(res.body.indexOf('<script nonce=') < res.body.indexOf('function status('));
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('Vercel cron rejects missing or incorrect bearer secrets without running jobs', async () => {
  let runs = 0;
  const database = { async ensureSchema() {} };
  const gmail = { async runEnabledUsers() { runs += 1; return []; } };
  try {
    await withEnvironment({ CRON_SECRET: 'c'.repeat(48) }, async () => {
      await withModuleMock('../lib/db', database, async () => withModuleMock('../lib/gmail', gmail, async () => {
        delete require.cache[require.resolve('../api/cron')];
        const handler = require('../api/cron');
        const denied = responseHarness();
        await handler({ method: 'GET', headers: {} }, denied);
        assert.equal(denied.statusCode, 401);
        const allowed = responseHarness();
        await handler({ method: 'GET', headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }, allowed);
        assert.equal(allowed.statusCode, 200);
        assert.equal(runs, 1);
      }));
    });
  } finally { delete require.cache[require.resolve('../api/cron')]; }
});
