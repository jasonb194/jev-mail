'use strict';

const database = require('./db');

function toEntry(row) {
  return {
    startedAt: new Date(row.started_at).getTime(),
    endedAt: new Date(row.ended_at).getTime(),
    source: row.source,
    outcome: row.outcome,
    succeeded: Number(row.succeeded) || 0,
    failed: Number(row.failed) || 0,
    deferred: Number(row.deferred) || 0,
    gmailQuota: row.gmail_quota === true,
    cooldownMinutes: row.cooldown_minutes == null ? undefined : Number(row.cooldown_minutes),
  };
}

async function getCooldown(subject) {
  return database.cooldownState(subject);
}

async function recordQuotaError(subject, durations) {
  return database.recordQuotaError(subject, durations);
}

async function clearQuotaCooldown(subject) {
  return database.clearQuotaCooldown(subject);
}

async function recordRun(subject, entry) {
  try { await database.finishRun(subject, entry); }
  finally { await database.clearRunStarted(subject); }
}

async function getRunHistory(subject) {
  return (await database.recentRuns(subject, 20)).map(toEntry);
}

async function markRunStarted(subject, data) {
  return database.claimRun(subject, data.source);
}

async function clearRunStarted(subject) {
  await database.clearRunStarted(subject);
}

async function dashboardHistory(subject) {
  const [cooldown, running, lastRuns] = await Promise.all([
    getCooldown(subject), database.runningRun(subject), getRunHistory(subject),
  ]);
  return { cooldown, running, lastRuns };
}

module.exports = { getCooldown, recordRun, recordQuotaError, clearQuotaCooldown, getRunHistory, markRunStarted, clearRunStarted, dashboardHistory };
