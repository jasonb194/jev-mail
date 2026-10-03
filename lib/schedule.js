'use strict';

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return parts.reduce((result, part) => { result[part.type] = part.value; return result; }, {});
}

function isJevScheduleEligible(settings, date = new Date()) {
  const { schedule } = settings;
  const local = localParts(date, schedule.timeZone);
  const day = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[local.weekday];
  const time = `${local.hour}:${local.minute}`;
  const { startTime: start, endTime: end, weekdays } = schedule;
  if (start === end) return weekdays.includes(day);
  if (start < end) return weekdays.includes(day) && time >= start && time < end;
  if (time >= start) return weekdays.includes(day);
  return time < end && weekdays.includes(day === 1 ? 7 : day - 1);
}

function nextJevScheduleInstant(settings, date = new Date()) {
  const interval = settings.intervalMinutes * 60 * 1000;
  const current = date.getTime();
  let candidate = new Date(Math.floor(current / interval) * interval + interval);
  for (let count = 0; count < 8 * 24 * 60; count += 1) {
    if (isJevScheduleEligible(settings, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + interval);
  }
  return new Date(current + 24 * 60 * 60 * 1000);
}

module.exports = { isJevScheduleEligible, nextJevScheduleInstant };
