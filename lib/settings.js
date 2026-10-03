'use strict';

const SUPPORTED_INTERVALS = [1, 5, 10, 15, 30];
const SETTINGS_KEYS = ['enabled', 'scope', 'intervalMinutes', 'model', 'apiUrl', 'schedule', 'defaultThreshold', 'fallbackLabel', 'categories', 'advanced'];

function isValidJevApiUrl(url) {
  try {
    const endpoint = new URL(url);
    const host = endpoint.hostname.toLowerCase().replace(/\.$/, '');
    return endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.hash &&
      host.includes('.') && !host.endsWith('.') && !host.endsWith('.localhost') && !host.endsWith('.local') &&
      !host.endsWith('.internal') && !host.endsWith('.test') &&
      !/^(\d{1,3}\.){3}\d{1,3}$/.test(host) && !host.startsWith('[');
  } catch (_) { return false; }
}

function getProviderKey(user) {
  if (!user || typeof user.providerApiKey !== 'string') return null;
  return require('./crypto').decryptSecret(user.providerApiKey);
}

const DEFAULT_CATEGORIES = [
  ['pending', 'Jev-Pending', 'External outcome or promised follow-up is still pending.'],
  ['people-personal', 'Jev-People & Personal', 'Direct personal correspondence with people in the recipient’s life.'],
  ['work-career', 'Jev-Work & Career', 'Professional work, recruiting, career, and employment matters.'],
  ['home-services', 'Jev-Home & Services', 'Home, property, maintenance, and essential household services.'],
  ['health-benefits', 'Jev-Health & Benefits', 'Medical care, health administration, insurance, and benefits.'],
  ['money-official-records', 'Jev-Money & Official Records', 'Banking, taxes, government, legal, and identity records.'],
  ['transactions-bookings', 'Jev-Transactions & Bookings', 'Purchases, payments, subscriptions, delivery, travel, and reservations.'],
  ['accounts-security', 'Jev-Accounts & Security', 'Account access, verification, security, and software-service events.'],
  ['news-promotions', 'Jev-News & Promotions', 'Newsletters, announcements, marketing, and social-network updates.'],
];

function createDefaultSettings() {
  return {
    enabled: false, scope: 'INBOX', intervalMinutes: 5, model: 'jev-latest',
    apiUrl: 'https://api.typesafe.ai/v1/systemone',
    schedule: { weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '00:00', endTime: '00:00', timeZone: 'America/New_York' },
    defaultThreshold: 0.75, fallbackLabel: 'Jev-Uncategoried',
    categories: DEFAULT_CATEGORIES.map(([key, label, description]) => ({ key, label, description, enabled: true, threshold: null })),
    advanced: {
      maxThreadsToFetch: 100, maxThreadsToClassify: 20, batchTargetTokens: 16000,
      maxRequestTokens: 32000, maxStateQuestionTokens: 20000, providerAttempts: 3,
      initialRetryDelayMs: 1000, gmailSpacingMs: 1000, cooldownMinutes: [15, 30, 60],
    },
  };
}

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Settings must be an object.');
  const settings = structuredClone(input);
  if (Object.keys(settings).some((key) => !SETTINGS_KEYS.includes(key))) throw new Error('Settings contain unsupported fields.');
  if (typeof settings.enabled !== 'boolean') throw new Error('Choose whether processing is enabled.');
  if (!['INBOX', 'ALL'].includes(settings.scope)) throw new Error('Choose INBOX or ALL mailbox scope.');
  if (!SUPPORTED_INTERVALS.includes(settings.intervalMinutes)) throw new Error('Choose a supported polling interval.');
  if (typeof settings.model !== 'string' || !settings.model.trim() || settings.model.length > 200) throw new Error('Model must not be empty or exceed 200 characters.');
  if (!isValidJevApiUrl(settings.apiUrl)) throw new Error('Enter a complete HTTPS endpoint without credentials or a fragment.');
  if (typeof settings.defaultThreshold !== 'number' || !Number.isFinite(settings.defaultThreshold) || settings.defaultThreshold < 0 || settings.defaultThreshold > 1) throw new Error('Threshold must be from 0 to 1.');
  if (typeof settings.fallbackLabel !== 'string' || !settings.fallbackLabel.trim() || settings.fallbackLabel.trim().length > 225) throw new Error('Fallback label must contain 1–225 characters.');
  settings.fallbackLabel = settings.fallbackLabel.trim();
  const schedule = settings.schedule;
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule) || Object.keys(schedule).some((key) => !['weekdays', 'startTime', 'endTime', 'timeZone'].includes(key))) throw new Error('Schedule is invalid.');
  if (!Array.isArray(schedule.weekdays) || !schedule.weekdays.length || schedule.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) || new Set(schedule.weekdays).size !== schedule.weekdays.length) throw new Error('Choose one or more unique weekdays.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.endTime)) throw new Error('Schedule times must use HH:MM.');
  if (typeof schedule.timeZone !== 'string' || schedule.timeZone.length > 100) throw new Error('Choose a valid timezone.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: schedule.timeZone }).format(new Date()); } catch (_) { throw new Error('Choose a valid timezone.'); }
  if (!Array.isArray(settings.categories) || settings.categories.length < 1 || settings.categories.length > 25) throw new Error('Add between 1 and 25 categories.');
  const keys = new Set();
  const labels = new Set([settings.fallbackLabel.toLowerCase(), 'jev']);
  settings.categories = settings.categories.map((category) => {
    if (!category || typeof category !== 'object' || Array.isArray(category) || Object.keys(category).some((key) => !['key', 'label', 'description', 'enabled', 'threshold'].includes(key))) throw new Error('A category contains unsupported fields.');
    if (typeof category.key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(category.key) || ['__proto__', 'constructor', 'prototype'].includes(category.key) || keys.has(category.key)) throw new Error('Category keys must be unique and valid.');
    if (typeof category.label !== 'string' || !category.label.trim() || category.label.trim().length > 225) throw new Error('Category labels must contain 1–225 characters.');
    const label = category.label.trim();
    if (['INBOX', 'STARRED', 'IMPORTANT', 'UNREAD', 'SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(label.toUpperCase()) || /^CATEGORY_/i.test(label) || labels.has(label.toLowerCase())) throw new Error('Category labels must be unique and cannot use reserved Gmail labels.');
    if (typeof category.description !== 'string' || !category.description.trim() || category.description.length > 2000) throw new Error('Category descriptions must contain 1–2,000 characters.');
    if (typeof category.enabled !== 'boolean') throw new Error('Choose whether each category is enabled.');
    if (category.threshold !== null && (typeof category.threshold !== 'number' || !Number.isFinite(category.threshold) || category.threshold < 0 || category.threshold > 1)) throw new Error('Category thresholds must be blank or from 0 to 1.');
    keys.add(category.key);
    labels.add(label.toLowerCase());
    return { key: category.key, label, description: category.description.trim(), enabled: category.enabled, threshold: category.threshold };
  });
  if (!settings.categories.some((category) => category.enabled)) throw new Error('Enable at least one category.');
  const advanced = settings.advanced;
  const advancedKeys = ['maxThreadsToFetch', 'maxThreadsToClassify', 'batchTargetTokens', 'maxRequestTokens', 'maxStateQuestionTokens', 'providerAttempts', 'initialRetryDelayMs', 'gmailSpacingMs', 'cooldownMinutes'];
  if (!advanced || typeof advanced !== 'object' || Array.isArray(advanced) || Object.keys(advanced).some((key) => !advancedKeys.includes(key))) throw new Error('Advanced settings are invalid.');
  const ranges = [['maxThreadsToFetch', 1, 100], ['maxThreadsToClassify', 1, advanced.maxThreadsToFetch], ['batchTargetTokens', 1000, advanced.maxRequestTokens], ['maxRequestTokens', 1000, 32000], ['maxStateQuestionTokens', 1000, Math.min(20000, advanced.maxRequestTokens)], ['providerAttempts', 1, 5], ['initialRetryDelayMs', 250, 5000], ['gmailSpacingMs', 1000, 10000]];
  for (const [key, min, max] of ranges) if (!Number.isInteger(advanced[key]) || advanced[key] < min || advanced[key] > max) throw new Error(`Advanced setting ${key} is out of range.`);
  if (!Array.isArray(advanced.cooldownMinutes) || advanced.cooldownMinutes.length !== 3 || advanced.cooldownMinutes.some((value, index) => !Number.isInteger(value) || value < 15 || value > 1440 || (index > 0 && value < advanced.cooldownMinutes[index - 1]))) throw new Error('Use three nondecreasing cooldowns from 15 to 1,440 minutes.');
  settings.schedule = { weekdays: [...schedule.weekdays], startTime: schedule.startTime, endTime: schedule.endTime, timeZone: schedule.timeZone };
  settings.advanced = Object.fromEntries(advancedKeys.map((key) => [key, key === 'cooldownMinutes' ? [...advanced[key]] : advanced[key]]));
  return settings;
}

function publicSettings(settings) {
  const { apiKey, ...visible } = settings;
  return structuredClone(visible);
}

module.exports = { SUPPORTED_INTERVALS, SETTINGS_KEYS, createDefaultSettings, validateSettings, publicSettings, isValidJevApiUrl, getProviderKey };
