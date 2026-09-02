'use strict';
const assert = require('assert');
const { reliability, cycleDueDates, nextBusinessDay, shuffle, currentCycle, isOnTime } = require('../api/core');

// reliability: neutral prior, monotonic, bounded
assert.strictEqual(reliability(0, 0), 50, 'new member starts neutral');
assert.strictEqual(reliability(1, 1), 55, 'one payment must not buy a perfect score');
assert.ok(reliability(50, 50) > reliability(40, 50), 'more on-time payments scores higher');
assert.ok(reliability(0, 50) < 20 && reliability(50, 50) < 100, 'stays inside sane bounds');

// due dates: 2026-01-03 is a Saturday, so +7d lands 2026-01-10 (Sat) -> Mon 12th
const plain = cycleDueDates('2026-01-01', 7, 3);
assert.deepStrictEqual(plain, ['2026-01-08', '2026-01-15', '2026-01-22'], 'weekday due dates pass through');
const weekend = cycleDueDates('2026-01-03', 7, 1);
assert.deepStrictEqual(weekend, ['2026-01-12'], 'weekend due date rolls to Monday');

// holidays push further forward
const holidays = new Set(['2026-01-08', '2026-01-09']);
assert.deepStrictEqual(cycleDueDates('2026-01-01', 7, 1, holidays), ['2026-01-12'], 'holiday run rolls past the weekend too');

// nextBusinessDay leaves a good day alone
assert.strictEqual(nextBusinessDay(new Date('2026-01-07T00:00:00Z')).toISOString().slice(0, 10), '2026-01-07');

// shuffle keeps every member exactly once
const members = ['a', 'b', 'c', 'd', 'e'];
assert.deepStrictEqual([...shuffle(members)].sort(), [...members].sort(), 'shuffle loses nobody');

// cycle tracking
const dues = ['2026-01-08', '2026-01-15', '2026-01-22'];
assert.strictEqual(currentCycle(dues, '2026-01-01'), 1);
assert.strictEqual(currentCycle(dues, '2026-01-15'), 2, 'due date itself is still open');
assert.strictEqual(currentCycle(dues, '2026-02-01'), 4, 'past the end -> group complete');

// on-time boundary
assert.ok(isOnTime('2026-01-08T23:59:00Z', '2026-01-08'), 'paying on the due date counts as on time');
assert.ok(!isOnTime('2026-01-09T00:01:00Z', '2026-01-08'), 'the next day does not');

console.log('all core logic checks passed');
