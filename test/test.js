'use strict';
const assert = require('assert');
const { reliability, cycleDueDates, nextBusinessDay, shuffle, currentCycle, isOnTime } = require('../api/core');
const { signRecord, recordIntact } = require('../api/auth');

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

// a holiday run longer than the cycle must not collapse two cycles onto one day:
// a repeated due date makes the second cycle unreachable in currentCycle()
const collide = cycleDueDates('2026-12-31', 1, 2, new Set(['2027-01-01']));
assert.deepStrictEqual(collide, ['2027-01-04', '2027-01-05'], 'due dates stay strictly increasing');
assert.strictEqual(currentCycle(collide, '2027-01-05'), 2, 'the second cycle is still reachable');

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

// tamper-evidence. Only rows the app never rewrites are signed, so the field
// lists below are the whole contract; a field dropped from one must fail here.
const profile = { PK: 'USER#u1', SK: 'PROFILE', userId: 'u1', email: 'a@b.c', name: 'A', passwordHash: 'h' };
profile.sig = signRecord(profile);
assert.ok(recordIntact(profile), 'an untouched profile verifies');
for (const field of ['PK', 'SK', 'userId', 'email', 'name', 'passwordHash']) {
  assert.ok(!recordIntact({ ...profile, [field]: 'tampered' }), `editing ${field} must break the signature`);
}
// counters are deliberately NOT signed: they move by atomic ADD, and signing a
// field that another write changes is how you lock a user out of their own row
assert.ok(recordIntact({ ...profile, onTimeCount: 99, contribCount: 99 }), 'counters stay outside the signature');

const contrib = { PK: 'GROUP#g1', SK: 'CONTRIB#002#u1', groupId: 'g1', userId: 'u1', userName: 'A', cycle: 2, amount: 1000, currency: 'VND', dueDate: '2026-01-08', paidAt: '2026-01-07T00:00:00.000Z', onTime: true, evidenceKey: 'evidence/g1/u1/x.png' };
contrib.sig = signRecord(contrib, 'contrib');
assert.ok(recordIntact(contrib, 'contrib'), 'an untouched ledger row verifies');
for (const field of ['PK', 'SK', 'groupId', 'userId', 'userName', 'cycle', 'amount', 'currency', 'dueDate', 'paidAt', 'onTime', 'evidenceKey']) {
  assert.ok(!recordIntact({ ...contrib, [field]: 'tampered' }, 'contrib'), `editing ${field} must break the ledger signature`);
}
// copying a valid row to another partition or cycle must not carry its signature
assert.ok(!recordIntact({ ...contrib, PK: 'GROUP#g2' }, 'contrib'), 'a row copied to another circle does not verify');
assert.ok(!recordIntact({ ...contrib, SK: 'CONTRIB#005#u1' }, 'contrib'), 'a row copied to another cycle does not verify');
assert.ok(!recordIntact(contrib, 'profile'), 'a ledger signature must not verify as a profile');

const emailRow = { PK: 'EMAIL#a@b.c', SK: 'USER', userId: 'u1' };
emailRow.sig = signRecord(emailRow, 'email');
assert.ok(recordIntact(emailRow, 'email'), 'an untouched email row verifies');
assert.ok(!recordIntact({ ...emailRow, userId: 'u2' }, 'email'), 'repointing the email row must break the signature');

// the signature binds the stored type, or swapping N for S turns the score
// arithmetic into string concatenation while still verifying
assert.ok(!recordIntact({ ...contrib, cycle: '2' }, 'contrib'), 'number 2 and string "2" must not share a signature');

assert.ok(!recordIntact({ ...profile, sig: undefined }), 'an unsigned row never verifies');
assert.ok(!recordIntact({ ...profile, sig: 'zz' }), 'a malformed signature never verifies');
assert.strictEqual(recordIntact(profile, 'no-such-kind'), false, 'an unknown record kind fails closed rather than throwing');

console.log('all core logic checks passed');
