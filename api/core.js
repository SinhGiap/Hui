'use strict';
// Pure domain logic: no AWS, no IO. Everything here is covered by test/test.js.
const crypto = require('crypto');

const PRIOR_ON_TIME = 5;
const PRIOR_TOTAL = 10;

// Beta(5,5) smoothing: a new member sits at 50, and one payment cannot buy 100.
function reliability(onTime, total) {
  return Math.round((100 * (onTime + PRIOR_ON_TIME)) / (total + PRIOR_TOTAL));
}

const isoDay = (d) => d.toISOString().slice(0, 10);

// Money cannot clear on a closed day, so shift forward rather than mark someone
// late. `holidays` is a Set of YYYY-MM-DD from the Nager.Date API.
function nextBusinessDay(date, holidays = new Set()) {
  const d = new Date(date.getTime());
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || holidays.has(isoDay(d))) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function cycleDueDates(startDate, cycleLengthDays, cycleCount, holidays = new Set()) {
  const start = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error('invalid startDate');
  const dates = [];
  for (let i = 0; i < cycleCount; i++) {
    const due = new Date(start.getTime());
    due.setUTCDate(due.getUTCDate() + (i + 1) * cycleLengthDays);
    // A weekend or a long holiday run (Tet) can roll a short cycle onto the day
    // the previous one already landed on. currentCycle() finds the first date not
    // yet passed, so a repeated date makes the second cycle unreachable and the
    // circle reads complete a cycle early. Keep them strictly increasing.
    const prev = dates[dates.length - 1];
    if (prev && isoDay(due) <= prev) due.setTime(Date.parse(`${prev}T00:00:00Z`) + 86400000);
    dates.push(isoDay(nextBusinessDay(due, holidays)));
  }
  return dates;
}

// Fisher-Yates with crypto randomness: a sort()-based shuffle is measurably
// biased, and this decides who gets the pot first.
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// First cycle whose due date has not passed. Returns dueDates.length + 1 once all
// are behind us, so `cycle > dueDates.length` means complete.
function currentCycle(dueDates, today = isoDay(new Date())) {
  const idx = dueDates.findIndex((d) => d >= today);
  return idx === -1 ? dueDates.length + 1 : idx + 1;
}

const isOnTime = (paidAtIso, dueDate) => paidAtIso.slice(0, 10) <= dueDate;

module.exports = { reliability, nextBusinessDay, cycleDueDates, shuffle, currentCycle, isOnTime, isoDay };
