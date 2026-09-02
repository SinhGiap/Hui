'use strict';
// Pure domain logic: no AWS, no IO. Everything here is covered by test/test.js.
const crypto = require('crypto');

const PRIOR_ON_TIME = 5;
const PRIOR_TOTAL = 10;

// Bayesian prior so a brand-new member sits at 50 rather than 0, and one lucky
// payment does not buy a 100. Beta(5,5) smoothing over the on-time ratio.
// ponytail: prior is a guess at "neutral trust" — tune PRIOR_* if scores read
// too forgiving in the demo data.
function reliability(onTime, total) {
  return Math.round((100 * (onTime + PRIOR_ON_TIME)) / (total + PRIOR_TOTAL));
}

const isoDay = (d) => d.toISOString().slice(0, 10);

// A contribution due on a weekend or public holiday cannot clear through a bank,
// so penalising a member for it would be wrong. Shift forward to the next day
// money can actually move. `holidays` is a Set of YYYY-MM-DD from the Nager.Date API.
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
  return Array.from({ length: cycleCount }, (_, i) => {
    const due = new Date(start.getTime());
    due.setUTCDate(due.getUTCDate() + (i + 1) * cycleLengthDays);
    return isoDay(nextBusinessDay(due, holidays));
  });
}

// Fisher-Yates with crypto randomness. A sort(() => Math.random() - 0.5) shuffle
// is shorter but measurably biased, and payout order decides who gets the pot first.
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Which cycle is live right now: the first whose due date has not passed.
// Returns dueDates.length + 1 once every cycle is behind us, so callers can test
// `cycle > dueDates.length` for "group complete" without it colliding with the
// genuinely-live final cycle.
function currentCycle(dueDates, today = isoDay(new Date())) {
  const idx = dueDates.findIndex((d) => d >= today);
  return idx === -1 ? dueDates.length + 1 : idx + 1;
}

const isOnTime = (paidAtIso, dueDate) => paidAtIso.slice(0, 10) <= dueDate;

module.exports = { reliability, nextBusinessDay, cycleDueDates, shuffle, currentCycle, isOnTime, isoDay, PRIOR_ON_TIME, PRIOR_TOTAL };
