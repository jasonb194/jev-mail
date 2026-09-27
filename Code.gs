const JEV_MAX_THREADS_TO_FETCH_ = 100;
const JEV_MAX_THREADS_TO_CLASSIFY_ = 30;
const JEV_CATEGORY_THRESHOLD_ = 0.75;
const JEV_PROCESSED_LABEL_ = 'JEV';
const JEV_TRIGGER_HANDLER_ = 'runJevBatch';
const JEV_TRIGGER_INTERVAL_PROPERTY_ = 'JEV_INTERNAL_TRIGGER_INTERVAL_MINUTES';
const JEV_SUPPORTED_INTERVALS_ = [1, 5, 10, 15, 30];
const JEV_RATE_LIMIT_MAX_ATTEMPTS_ = 3;
const JEV_RATE_LIMIT_INITIAL_DELAY_MS_ = 1000;

const JEV_DEFAULT_PROPERTIES_ = {
  JEV_API_KEY: '',
  JEV_ENABLED: 'false',
  JEV_SCOPE: 'INBOX',
  JEV_INTERVAL_MINUTES: '5',
  JEV_MODEL: 'jev-latest',
  JEV_API_URL: 'https://api.typesafe.ai/v1/systemone',
};

/**
 * Seeds missing configuration properties and installs the scheduled trigger.
 * Existing property values are preserved.
 */
function initializeJevProperties() {
  const properties = PropertiesService.getScriptProperties();
  const existing = properties.getProperties();
  Object.keys(JEV_DEFAULT_PROPERTIES_).forEach(function (key) {
    if (existing[key] === undefined) {
      properties.setProperty(key, JEV_DEFAULT_PROPERTIES_[key]);
    }
  });

  installJevTrigger();
  console.log('[JEV] Defaults initialized and scheduled trigger installed.');
}

/** Installs or repairs the single scheduled JEV batch trigger. */
function installJevTrigger() {
  const config = getJevConfig_();
  ensureJevTrigger_(config.intervalMinutes);
  console.log('[JEV] Trigger configured for every ' + config.intervalMinutes + ' minute(s).');
}

/** Scheduled entry point. */
function runJevBatch() {
  let config;
  try {
    config = getJevConfig_();
    ensureJevTrigger_(config.intervalMinutes);
  } catch (error) {
    console.error('[JEV] Invalid configuration or trigger setup; batch skipped: ' + getSafeErrorMessage_(error));
    return;
  }

  if (!config.enabled) {
    console.log('[JEV] Disabled; no Gmail search or API request made.');
    return;
  }
  if (!config.apiKey) {
    console.error('[JEV] Enabled but JEV_API_KEY is empty; batch skipped.');
    return;
  }

  let threadRefs;
  try {
    threadRefs = findUncategorizedThreads_(config.scope, JEV_MAX_THREADS_TO_FETCH_);
  } catch (error) {
    console.error('[JEV] Gmail search failed; batch skipped: ' + getSafeErrorMessage_(error, config.apiKey));
    return;
  }

  const batch = threadRefs.slice(0, JEV_MAX_THREADS_TO_CLASSIFY_);
  console.log('[JEV] Found ' + threadRefs.length + ' candidate thread(s); classifying ' + batch.length + '.');
  if (!batch.length) return;

  let labelIdsByName;
  try {
    labelIdsByName = getLabelIdsByName_();
    getOrCreateLabelId_(JEV_PROCESSED_LABEL_, labelIdsByName);
  } catch (error) {
    console.error('[JEV] Could not read or create Gmail labels; batch skipped: ' + getSafeErrorMessage_(error, config.apiKey));
    return;
  }

  let succeeded = 0;
  let failed = 0;
  let deferred = 0;
  for (let i = 0; i < batch.length; i += 1) {
    const threadRef = batch[i];
    try {
      processThread_(threadRef.id, config, labelIdsByName);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      console.error('[JEV] Thread processing failed for ' + threadRef.id + ': ' + getSafeErrorMessage_(error, config.apiKey));
      if (isJevRateLimitError_(error)) {
        deferred = batch.length - i - 1;
        console.error('[JEV] Stopping this batch after repeated rate limiting; remaining thread(s) will be retried on a later trigger.');
        break;
      }
    }
  }
  console.log('[JEV] Batch complete: ' + succeeded + ' succeeded, ' + failed + ' failed, ' + deferred + ' deferred.');
}

function getSafeErrorMessage_(error, apiKey) {
  let message = error && error.message ? String(error.message) : String(error || 'Unknown error');
  if (apiKey) message = message.split(apiKey).join('[REDACTED]');
  return message.slice(0, 300);
}

function isJevRateLimitError_(error) {
  return Boolean(error && (error.statusCode === 429 || error.statusCode === 529));
}

/** Reads and validates user-editable Script Properties. */
function getJevConfig_() {
  const properties = PropertiesService.getScriptProperties().getProperties();
  const raw = {};
  Object.keys(JEV_DEFAULT_PROPERTIES_).forEach(function (key) {
    raw[key] = properties[key] === undefined ? JEV_DEFAULT_PROPERTIES_[key] : properties[key];
  });

  const enabled = parseBooleanProperty_(raw.JEV_ENABLED, 'JEV_ENABLED');
  const scope = String(raw.JEV_SCOPE).trim().toUpperCase();
  if (scope !== 'INBOX' && scope !== 'ALL') {
    throw new Error('JEV_SCOPE must be INBOX or ALL.');
  }

  const intervalMinutes = Number(String(raw.JEV_INTERVAL_MINUTES).trim());
  if (JEV_SUPPORTED_INTERVALS_.indexOf(intervalMinutes) < 0) {
    throw new Error('JEV_INTERVAL_MINUTES must be 1, 5, 10, 15, or 30.');
  }

  const model = String(raw.JEV_MODEL).trim();
  if (!model) throw new Error('JEV_MODEL must not be empty.');

  const apiUrl = String(raw.JEV_API_URL).trim();
  if (!isValidJevApiUrl_(apiUrl)) {
    throw new Error('JEV_API_URL must be a complete HTTPS endpoint, such as https://api.typesafe.ai/v1/systemone.');
  }

  return {
    apiKey: String(raw.JEV_API_KEY || '').trim(),
    enabled: enabled,
    scope: scope,
    intervalMinutes: intervalMinutes,
    model: model,
    apiUrl: apiUrl,
  };
}

function parseBooleanProperty_(value, propertyName) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(propertyName + ' must be true or false.');
}

function isValidJevApiUrl_(url) {
  if (!url || /\s/.test(url) || url.indexOf('#') >= 0) return false;
  if (!/^https:\/\/[^/?#]+(?:\/[^?#]*)?(?:\?[^#]*)?$/i.test(url)) return false;
  const authority = url.substring('https://'.length).split(/[/?#]/)[0];
  return authority.length > 0 && authority.indexOf('@') < 0 && authority.indexOf('\\') < 0;
}

/** Keeps one runJevBatch trigger and reconciles it after interval changes. */
function ensureJevTrigger_(intervalMinutes) {
  const intervalText = String(intervalMinutes);
  const properties = PropertiesService.getScriptProperties();
  const installedInterval = properties.getProperty(JEV_TRIGGER_INTERVAL_PROPERTY_);
  const existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === JEV_TRIGGER_HANDLER_;
  });

  if (installedInterval === intervalText && existing.length === 1) return;

  existing.forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger(JEV_TRIGGER_HANDLER_)
    .timeBased()
    .everyMinutes(intervalMinutes)
    .create();
  properties.setProperty(JEV_TRIGGER_INTERVAL_PROPERTY_, intervalText);
}

/** Returns at most maxThreads unprocessed Gmail threads for the chosen scope. */
function findUncategorizedThreads_(scope, maxThreads) {
  const scopeQuery = scope === 'INBOX' ? 'in:inbox' : 'in:anywhere';
  const query = scopeQuery + ' -in:spam -in:trash -in:sent -in:drafts -label:' + JEV_PROCESSED_LABEL_;
  const result = Gmail.Users.Threads.list('me', {
    q: query,
    maxResults: Math.min(maxThreads, JEV_MAX_THREADS_TO_FETCH_),
  });
  return result && result.threads ? result.threads.filter(function (thread) {
    return Boolean(thread && thread.id);
  }) : [];
}

/** Serializes incoming messages in the thread, excluding Spam, Trash, Sent, and Drafts. */
function threadToJevState_(threadId) {
  const thread = Gmail.Users.Threads.get('me', threadId, { format: 'full' });
  const allMessages = thread && thread.messages ? thread.messages : [];
  const eligibleMessages = allMessages.filter(function (message) {
    const labels = message.labelIds || [];
    return labels.indexOf('SPAM') < 0 &&
      labels.indexOf('TRASH') < 0 &&
      labels.indexOf('SENT') < 0 &&
      labels.indexOf('DRAFT') < 0;
  });

  if (!eligibleMessages.length) {
    throw new Error('Thread contains no eligible messages.');
  }

  const messages = eligibleMessages.map(function (message) {
    const payload = message.payload || {};
    return {
      sender: getHeaderValue_(payload.headers, 'From'),
      subject: getHeaderValue_(payload.headers, 'Subject'),
      body: getPlainTextBody_(payload),
    };
  });

  return {
    state: { messages: messages },
    messageIds: eligibleMessages.map(function (message) { return message.id; }),
  };
}

function getHeaderValue_(headers, name) {
  const target = String(name).toLowerCase();
  const match = (headers || []).filter(function (header) {
    return String(header.name || '').toLowerCase() === target;
  })[0];
  return match ? String(match.value || '') : '';
}

function getPlainTextBody_(payload) {
  const bodies = { plain: [], html: [] };
  collectBodyParts_(payload, bodies, false);
  if (bodies.plain.length) return bodies.plain.join('\n\n').trim();
  if (bodies.html.length) return htmlToPlainText_(bodies.html.join('\n\n'));
  return '';
}

function collectBodyParts_(part, bodies, isAttachment) {
  if (!part || isAttachment || part.filename) return;
  const mimeType = String(part.mimeType || '').toLowerCase();
  const data = part.body && part.body.data;
  if (data) {
    const decoded = decodeBase64Url_(data);
    if (mimeType === 'text/plain') bodies.plain.push(decoded);
    else if (mimeType === 'text/html') bodies.html.push(decoded);
  }
  (part.parts || []).forEach(function (child) {
    collectBodyParts_(child, bodies, Boolean(child && child.filename));
  });
}

function decodeBase64Url_(encoded) {
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(encoded)).getDataAsString('UTF-8');
}

function htmlToPlainText_(html) {
  return String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

/** Sends one thread and all nine independent category questions to Jev. */
function classifyThread_(state, config) {
  const questions = {};
  JEV_CATEGORIES.forEach(function (category) {
    questions[category.key] = {
      type: 'noul',
      instructions: 'Does this email thread fit the ' + category.label + ' category?',
      criteria: {
        true: category.description,
        false: 'The thread does not fit this category.',
      },
    };
  });

  const requestOptions = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.apiKey },
    payload: JSON.stringify({
      model: config.model,
      state: state,
      questions: questions,
    }),
    followRedirects: false,
    muteHttpExceptions: true,
  };
  let response;
  for (let attempt = 0; attempt < JEV_RATE_LIMIT_MAX_ATTEMPTS_; attempt += 1) {
    response = UrlFetchApp.fetch(config.apiUrl, requestOptions);
    const responseStatus = response.getResponseCode();
    if ((responseStatus === 429 || responseStatus === 529) && attempt + 1 < JEV_RATE_LIMIT_MAX_ATTEMPTS_) {
      Utilities.sleep(JEV_RATE_LIMIT_INITIAL_DELAY_MS_ * Math.pow(2, attempt));
      continue;
    }
    break;
  }

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    const error = new Error('JEV API returned HTTP ' + status + '.');
    error.statusCode = status;
    throw error;
  }

  let result;
  try {
    result = JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error('JEV API returned invalid JSON.');
  }
  if (!result || !result.answers) {
    throw new Error('JEV API response is missing answers.');
  }

  const scores = {};
  JEV_CATEGORIES.forEach(function (category) {
    const answer = result.answers[category.key];
    if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number' ||
        !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error('JEV API response has an invalid category answer.');
    }
    scores[category.key] = answer.noul;
  });
  return scores;
}

function getLabelIdsByName_() {
  const result = Gmail.Users.Labels.list('me');
  const labels = result && result.labels ? result.labels : [];
  const byName = {};
  labels.forEach(function (label) {
    if (label && label.name && label.id) byName[label.name] = label.id;
  });
  return byName;
}

function getOrCreateLabelId_(name, labelIdsByName) {
  if (labelIdsByName[name]) return labelIdsByName[name];
  const created = Gmail.Users.Labels.create({
    name: name,
    labelListVisibility: 'labelShow',
    messageListVisibility: 'show',
  }, 'me');
  if (!created || !created.id) throw new Error('Gmail did not return a label ID.');
  labelIdsByName[name] = created.id;
  return created.id;
}

function processThread_(threadId, config, labelIdsByName) {
  const threadData = threadToJevState_(threadId);
  const scores = classifyThread_(threadData.state, config);
  const labelsToAdd = [];

  JEV_CATEGORIES.forEach(function (category) {
    if (scores[category.key] > JEV_CATEGORY_THRESHOLD_) {
      labelsToAdd.push(getOrCreateLabelId_(category.label, labelIdsByName));
    }
  });
  labelsToAdd.push(getOrCreateLabelId_(JEV_PROCESSED_LABEL_, labelIdsByName));

  // Gmail's batch modify limit is 1,000 message IDs per request. Refuse an
  // unusually large thread before changing any labels; it will remain eligible
  // for retry after the thread is handled separately.
  if (threadData.messageIds.length > 1000) {
    throw new Error('Thread exceeds the Gmail batch label limit.');
  }

  // Label only eligible incoming messages in one request, leaving Spam, Trash,
  // Sent, and Draft messages untouched even when they share a conversation.
  Gmail.Users.Messages.batchModify({
    addLabelIds: labelsToAdd,
    ids: threadData.messageIds,
  }, 'me');
}
