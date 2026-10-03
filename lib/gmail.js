'use strict';

const dns = require('node:dns');
const https = require('node:https');
const net = require('node:net');
const { decryptSecret, encryptSecret } = require('./crypto');
const { validateSettings, getProviderKey } = require('./settings');
const { userById, saveUserSettings, scheduleNextRun, disconnectUser } = require('./db');
const { recordRun, recordQuotaError, clearQuotaCooldown, getCooldown, markRunStarted, clearRunStarted, dashboardHistory } = require('./run-history');
const { isJevScheduleEligible, nextJevScheduleInstant } = require('./schedule');


async function googleAccessToken(user) {
  const refreshToken = decryptSecret(user.refreshToken);
  if (!refreshToken) throw new Error('Connect your Google account to process Gmail.');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || typeof payload.access_token !== 'string') {
    if (payload.error === 'invalid_grant') await disconnectUser(user.subject);
    throw new Error('Google authorization expired. Reconnect your account.');
  }
  return payload.access_token;
}

async function gmailRequest(accessToken, method, path, body, subject, pacing) {
  if (pacing) {
    const wait = pacing.spacingMs - (Date.now() - pacing.lastAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    pacing.lastAt = Date.now();
  }
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method, headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    const reasonCodes = Array.isArray(details.error && details.error.errors) ? details.error.errors.map((entry) => String(entry.reason || '').toLowerCase()).join(' ') : '';
    const reasons = `${reasonCodes} ${String(details.error && details.error.status || '').toLowerCase()}`;
    const message = String(details.error && details.error.message || '').toLowerCase();
    const quota = response.status === 429 || (response.status === 403 && (/(ratelimit|quota|userratelimit)/.test(reasons) || /quota exceeded|rate limit exceeded/.test(message)));
    if (response.status === 401 && subject) await disconnectUser(subject);
    const error = new Error(quota ? 'Gmail rate limit exceeded.' : 'Gmail request failed.');
    error.status = quota ? 429 : response.status;
    error.statusCode = quota ? 429 : undefined;
    error.gmailQuota = quota;
    throw error;
  }
  return response.status === 204 ? {} : response.json();
}


function decodeBase64Url(data) {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function plainText(payload) {
  const parts = [];
  function collect(part) {
    if (!part || part.filename) return;
    if (part.mimeType === 'text/plain' && part.body && part.body.data) parts.push(decodeBase64Url(part.body.data));
    (part.parts || []).forEach(collect);
  }
  collect(payload);
  if (parts.length) return parts.join('\n\n').trim();
  const html = [];
  function collectHtml(part) {
    if (!part || part.filename) return;
    if (part.mimeType === 'text/html' && part.body && part.body.data) html.push(decodeBase64Url(part.body.data));
    (part.parts || []).forEach(collectHtml);
  }
  collectHtml(payload);
  return html.join('\n\n').replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ').replace(/<\s*br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}
function headerValue(headers, name) {
  const header = (headers || []).find((value) => String(value.name || '').toLowerCase() === name.toLowerCase());
  return header ? String(header.value || '') : '';
}
function extractThread(thread) {
  const messages = (thread.messages || []).filter((message) => !['SPAM', 'TRASH', 'SENT', 'DRAFT'].some((label) => (message.labelIds || []).includes(label)));
  if (!messages.length) return null;
  return {
    state: { messages: messages.map((message) => ({ sender: headerValue(message.payload && message.payload.headers, 'From'), subject: headerValue(message.payload && message.payload.headers, 'Subject'), body: plainText(message.payload || {}) })) },
    messageIds: messages.map((message) => message.id).filter(Boolean),
  };
}

async function getLabelIds(accessToken, subject, pacing) {
  const result = await gmailRequest(accessToken, 'GET', 'labels', undefined, subject, pacing);
  const labels = Object.create(null);
  (result.labels || []).forEach((label) => { if (label.type === 'user' && label.id) labels[label.name] = label.id; });
  return labels;
}
async function ensureLabel(accessToken, labels, name, subject, pacing) {
  if (labels[name]) return labels[name];
  const created = await gmailRequest(accessToken, 'POST', 'labels', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, subject, pacing);
  labels[name] = created.id;
  return created.id;
}

function classificationPayload(items, settings) {
  const state = { threads: {} };
  const questions = {};
  const mappings = [];
  const categories = settings.categories.filter((category) => category.enabled);
  items.forEach((item, index) => {
    const threadKey = `item_${String(index).padStart(3, '0')}`;
    state.threads[threadKey] = item.threadData.state;
    categories.forEach((category) => {
      const key = `${threadKey}__${category.key}`;
      questions[key] = { type: 'noul', instructions: `Use only state.threads.${threadKey} (this thread’s eligible messages). Does this email thread fit the ${category.label} category?`, criteria: { true: category.description, false: 'The thread does not fit this category.' } };
      mappings.push({ key, index, category });
    });
  });
  return { payload: { model: settings.model, state, questions }, mappings };
}

function classificationSize(items, settings) {
  const { payload, mappings } = classificationPayload(items, settings);
  const requestTokens = Math.ceil(JSON.stringify(payload).length / 4);
  const stateQuestionTokens = mappings.reduce((largest, mapping) => {
    const scope = { state: payload.state, question: payload.questions[mapping.key] };
    return Math.max(largest, Math.ceil(JSON.stringify(scope).length / 4));
  }, 0);
  return { payload, mappings, requestTokens, stateQuestionTokens };
}

function fitThreadToLimits(item, settings) {
  const initial = classificationSize([item], settings);
  if (initial.requestTokens <= settings.advanced.maxRequestTokens && initial.stateQuestionTokens <= settings.advanced.maxStateQuestionTokens) return true;
  const messages = item.threadData.state.messages;
  const originals = messages.map((message) => message.body || '');
  const longest = originals.reduce((maximum, body) => Math.max(maximum, body.length), 0);
  if (!longest) return false;
  const applyCap = (cap) => messages.forEach((message, index) => {
    const body = originals[index];
    let end = Math.min(cap, body.length);
    if (end > 0 && end < body.length && /[\\uD800-\\uDBFF]/.test(body[end - 1]) && /[\\uDC00-\\uDFFF]/.test(body[end])) end -= 1;
    message.body = end < body.length ? body.slice(0, end) + '\\n[body truncated]' : body;
  });
  applyCap(0);
  let size = classificationSize([item], settings);
  if (size.requestTokens > settings.advanced.maxRequestTokens || size.stateQuestionTokens > settings.advanced.maxStateQuestionTokens) {
    messages.forEach((message, index) => { message.body = originals[index]; });
    return false;
  }
  let low = 0;
  let high = longest;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    applyCap(middle);
    size = classificationSize([item], settings);
    if (size.requestTokens > settings.advanced.maxRequestTokens || size.stateQuestionTokens > settings.advanced.maxStateQuestionTokens) high = middle;
    else low = middle;
  }
  applyCap(low);
  return true;
}

function isPublicAddress(address, family) {
  const version = family === 4 || family === 'IPv4' ? 4 : family === 6 || family === 'IPv6' ? 6 : net.isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b, c] = octets;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (version !== 6 || !net.isIPv6(address)) return false;
  const normalized = address.toLowerCase();
  // Permit only global-unicast 2000::/3 and reject documentation/protocol-assignment ranges.
  const first = parseInt(normalized.split(':')[0] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff &&
    !normalized.startsWith('2001:db8:') && !normalized.startsWith('2001:0:') &&
    !normalized.startsWith('2001::') && !normalized.startsWith('2001:2:');
}

function providerPost(urlValue, apiKey, payload) {
  const url = new URL(urlValue);
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:', hostname: url.hostname, port: url.port || 443,
      path: `${url.pathname}${url.search}`, method: 'POST', servername: url.hostname,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      lookup(host, options, callback) {
        dns.lookup(host, { all: true, verbatim: true }, (error, addresses) => {
          if (error) return callback(error);
          if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address, entry.family))) return callback(new Error('Classification provider resolved to a non-public address.'));
          const compatible = addresses.filter((entry) => options && options.family ? entry.family === options.family : true);
          if (!compatible.length) return callback(Object.assign(new Error('Classification provider has no compatible DNS address.'), { code: 'ENOTFOUND' }));
          if (options && options.all) return callback(null, compatible);
          const selected = compatible[0];
          return callback(null, selected.address, selected.family);
        });
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) request.destroy(new Error('Classification response is too large.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, async json() { return JSON.parse(text); } });
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('Classification provider timed out.')));
    request.on('error', reject);
    request.end(JSON.stringify(payload));
  });
}

async function classify(items, settings, apiKey) {
  const { payload, mappings, requestTokens, stateQuestionTokens } = classificationSize(items, settings);
  if (requestTokens > settings.advanced.maxRequestTokens || stateQuestionTokens > settings.advanced.maxStateQuestionTokens) throw new Error('Classification request exceeds the configured token budget.');
  let result;
  for (let attempt = 0; attempt < settings.advanced.providerAttempts; attempt += 1) {
    const response = await providerPost(settings.apiUrl, apiKey, payload);
    if ((response.status === 429 || response.status === 529) && attempt + 1 < settings.advanced.providerAttempts) {
      await new Promise((resolve) => setTimeout(resolve, settings.advanced.initialRetryDelayMs * (2 ** attempt)));
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(`Classification provider returned HTTP ${response.status}.`), { providerStatus: response.status });
    result = await response.json();
    break;
  }
  if (!result || !result.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) throw new Error('Classification response is invalid.');
  const scores = items.map(() => Object.create(null));
  mappings.forEach(({ key, index, category }) => {
    const answer = result.answers[key];
    if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error('Classification response is invalid.');
    scores[index][category.key] = answer.noul;
  });
  return scores;
}

async function applyItemLabels(accessToken, items, scores, settings, labels, subject, pacing) {
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < items.length; index += 1) {
    const matched = settings.categories.filter((category) => category.enabled && scores[index][category.key] > (category.threshold === null ? settings.defaultThreshold : category.threshold));
    const names = matched.length ? matched.map((category) => category.label) : [settings.fallbackLabel];
    names.push('JEV');
    try {
      const labelIds = [];
      for (const name of names) labelIds.push(await ensureLabel(accessToken, labels, name, subject, pacing));
      await gmailRequest(accessToken, 'POST', 'messages/batchModify', { ids: items[index].threadData.messageIds, addLabelIds: labelIds }, subject, pacing);
      succeeded += 1;
    } catch (error) {
      if (error.status === 429 || error.status === 401 || error.gmailQuota) throw error;
      failed += 1;
    }
  }
  return { succeeded, failed };
}

async function processUser(user, { manual = false } = {}) {
  const settings = validateSettings(user.settings);
  if (!settings.enabled && !manual) return { succeeded: 0, failed: 0, skipped: true };
  const apiKey = getProviderKey(user);
  if (!apiKey) throw new Error('Add a classification API key in Settings first.');
  if ((await getCooldown(user.subject)).active) return { succeeded: 0, failed: 0, skipped: true, reason: 'cooldown' };
  if (!manual && !isJevScheduleEligible(settings)) return { succeeded: 0, failed: 0, skipped: true, reason: 'schedule_ineligible' };
  const accessToken = await googleAccessToken(user);
  const pacing = { lastAt: 0, spacingMs: settings.advanced.gmailSpacingMs };
  const query = `${settings.scope === 'INBOX' ? 'in:inbox' : 'in:anywhere'} -in:spam -in:trash -in:sent -in:drafts -label:JEV`;
  const listed = await gmailRequest(accessToken, 'GET', `threads?q=${encodeURIComponent(query)}&maxResults=${Math.min(settings.advanced.maxThreadsToFetch, 100)}`, undefined, user.subject, pacing);
  const threads = (listed.threads || []).filter((thread) => thread && thread.id).slice(0, settings.advanced.maxThreadsToClassify);
  const items = [];
  let preparationFailures = 0;
  for (const thread of threads) {
    const fetched = await gmailRequest(accessToken, 'GET', `threads/${encodeURIComponent(thread.id)}?format=full`, undefined, user.subject, pacing);
    const threadData = extractThread(fetched);
    if (threadData && threadData.messageIds.length <= 1000) {
      const item = { threadId: thread.id, threadData };
      if (fitThreadToLimits(item, settings)) items.push(item);
      else preparationFailures += 1;
    }
  }
  if (!items.length) return { succeeded: 0, failed: preparationFailures };
  const labels = await getLabelIds(accessToken, user.subject, pacing);
  const summary = { succeeded: 0, failed: preparationFailures };
  let group = [];
  async function flushGroup() {
    if (!group.length) return;
    const current = group;
    group = [];
    try {
      const scores = await classify(current, settings, apiKey);
      const labeled = await applyItemLabels(accessToken, current, scores, settings, labels, user.subject, pacing);
      summary.succeeded += labeled.succeeded;
      summary.failed += labeled.failed;
    } catch (error) {
      summary.failed += current.length;
      if (error.status === 401 || error.status === 429 || error.gmailQuota) throw error;
    }
  }
  for (const item of items) {
    const proposed = group.concat(item);
    const size = classificationSize(proposed, settings);
    if (group.length && (size.requestTokens > settings.advanced.maxRequestTokens || size.stateQuestionTokens > settings.advanced.maxStateQuestionTokens || size.requestTokens > settings.advanced.batchTargetTokens)) await flushGroup();
    group.push(item);
    const singleOrCurrent = classificationSize(group, settings);
    if (singleOrCurrent.requestTokens >= settings.advanced.batchTargetTokens) await flushGroup();
  }
  await flushGroup();
  return summary;
}

async function runUserById(subject) {
  const user = await userById(subject);
  if (!user || !user.refreshToken || !user.settings.enabled) return { skipped: true };
  const startedAt = Date.now();
  if (!(await markRunStarted(subject, { source: 'scheduled' }))) return { skipped: true, reason: 'already_running' };
  try {
    const summary = await processUser(user);
    const next = nextJevScheduleInstant(validateSettings(user.settings));
    await scheduleNextRun(subject, Math.max(1, Math.ceil((next.getTime() - Date.now()) / 60000)));
    if (!summary.skipped) await recordRun(subject, { startedAt, endedAt: Date.now(), source: 'scheduled', outcome: summary.failed ? 'partial' : 'complete', succeeded: summary.succeeded || 0, failed: summary.failed || 0, deferred: 0 });
    if (!summary.failed && !summary.skipped) await clearQuotaCooldown(subject);
    return summary;
  } catch (error) {
    const quotaRun = error.gmailQuota === true;
    const cooldownMinutes = user.settings.intervalMinutes || 5;
    if (quotaRun) await recordQuotaError(subject, validateSettings(user.settings).advanced.cooldownMinutes);
    await scheduleNextRun(subject, cooldownMinutes);
    await recordRun(subject, { startedAt, endedAt: Date.now(), source: 'scheduled', outcome: 'failed', succeeded: 0, failed: 1, deferred: 0, gmailQuota: quotaRun, cooldownMinutes: validateSettings(user.settings).advanced.cooldownMinutes[0] });
    throw error;
  } finally { await clearRunStarted(subject).catch(() => {}); }
}

async function runEnabledUsers() {
  const { claimDueUsers } = require('./db');
  const due = await claimDueUsers(1);
  const results = [];
  for (const entry of due) {
    try { results.push(await runUserById(entry.google_sub)); }
    catch (_) { results.push({ failed: true }); }
  }
  return results;
}

async function runNow(subject) {
  const user = await userById(subject);
  if (!user || !user.refreshToken) throw new Error('Connect your Google account first.');
  if (!user.providerApiKey) throw new Error('Add a classification API key in Settings first.');
  if ((await getCooldown(subject)).active) throw Object.assign(new Error('Gmail quota cooldown is active.'), { statusCode: 429 });
  if (!(await markRunStarted(subject, { source: 'manual' }))) throw Object.assign(new Error('JEV is already processing.'), { statusCode: 409 });
  const startedAt = Date.now();
  try {
    const summary = await processUser(user, { manual: true });
    if (!summary.failed && !summary.skipped) await clearQuotaCooldown(subject);
    await recordRun(subject, { startedAt, endedAt: Date.now(), source: 'manual', outcome: summary.failed ? 'partial' : 'complete', succeeded: summary.succeeded || 0, failed: summary.failed || 0, deferred: 0 });
    return summary;
  } catch (error) {
    if (error.gmailQuota === true) await recordQuotaError(subject, validateSettings(user.settings).advanced.cooldownMinutes);
    await recordRun(subject, { startedAt, endedAt: Date.now(), source: 'manual', outcome: 'failed', succeeded: 0, failed: 1, deferred: 0, gmailQuota: error.gmailQuota === true, cooldownMinutes: validateSettings(user.settings).advanced.cooldownMinutes[0] || 15 });
    throw error;
  } finally { await clearRunStarted(subject).catch(() => {}); }
}

async function getDashboard(subject) {
  const user = await userById(subject);
  if (!user) throw new Error('Google account is not connected.');
  const history = await dashboardHistory(subject);
  const publicSettings = { ...user.settings };
  return { email: user.email, revision: user.revision, settings: publicSettings, apiKeyConfigured: Boolean(user.providerApiKey), connected: Boolean(user.refreshToken), nextRunAt: user.nextRunAt || null, cooldown: history.cooldown, running: history.running, lastRuns: history.lastRuns };
}

async function saveSettings(subject, email, request) {
  const current = await userById(subject);
  if (!current || !current.refreshToken) throw new Error('Connect your Google account first.');
  if (!request || !Number.isInteger(request.expectedRevision) || request.expectedRevision !== current.revision) throw Object.assign(new Error('Settings changed in another tab. Reload before saving.'), { statusCode: 409 });
  const allowed = ['enabled', 'scope', 'intervalMinutes', 'model', 'apiUrl', 'schedule', 'defaultThreshold', 'fallbackLabel', 'categories', 'advanced'];
  if (!request.settings || Object.keys(request.settings).some((key) => !allowed.includes(key))) throw Object.assign(new Error('Settings contain unsupported fields.'), { statusCode: 400 });
  const settings = validateSettings(request.settings);
  if (!['keep', 'replace', 'clear'].includes(request.apiKeyAction)) throw Object.assign(new Error('Choose how to handle the API key.'), { statusCode: 400 });
  if (request.apiKeyAction === 'clear' && settings.enabled) throw Object.assign(new Error('Pause scheduled processing before clearing the API key.'), { statusCode: 400 });
  if (request.apiKeyAction === 'replace' && (typeof request.apiKey !== 'string' || request.apiKey.trim().length > 4096)) throw Object.assign(new Error('API key must be a string of at most 4,096 characters.'), { statusCode: 400 });
  if (settings.enabled && request.apiKeyAction !== 'clear' && !current.providerApiKey && !(request.apiKeyAction === 'replace' && request.apiKey)) throw Object.assign(new Error('Add a classification API key before enabling scheduled processing.'), { statusCode: 400 });
  const nextKey = request.apiKeyAction === 'clear' ? null : request.apiKeyAction === 'replace' ? encryptSecret(String(request.apiKey || '').trim()) : undefined;
  if (request.apiKeyAction === 'replace' && !nextKey) throw Object.assign(new Error('Enter a nonempty API key.'), { statusCode: 400 });
  const saved = await saveUserSettings({ subject, email, settings, expectedRevision: current.revision, providerApiKey: nextKey });
  if (!saved) throw Object.assign(new Error('Settings changed in another tab. Reload before saving.'), { statusCode: 409 });
  return { ok: true, revision: saved.revision, settings: saved.settings, apiKeyConfigured: Boolean(saved.providerApiKey) };
}

module.exports = { processUser, runUserById, runEnabledUsers, runNow, getDashboard, saveSettings, googleAccessToken, extractThread, classificationPayload, classificationSize, fitThreadToLimits, classify, isPublicAddress };
