'use strict';
// Demo data: four members, one group already several cycles deep, with a
// deliberate spread of on-time and late payments so reliability scores and the
// Athena report have something to show during the demo.
//
// Contributions are written straight to DynamoDB because the API stamps paidAt
// with server time, and a convincing demo needs history.
const db = require('../api/db');
const { dispatch } = require('../api/routes');
const { reliability, isOnTime } = require('../api/core');

const PASSWORD = 'Rosca!2026';
const PEOPLE = [
  { name: 'Mai Tran', email: 'mai@example.com', pattern: [1, 1, 1, 1] },
  { name: 'Hui Nguyen', email: 'hui@example.com', pattern: [1, 1, 0, 1] },
  { name: 'Duc Pham', email: 'duc@example.com', pattern: [1, 0, 0, 1] },
  { name: 'Linh Vo', email: 'linh@example.com', pattern: [1, 1, 1, 0] },
];

const call = (method, path, body, token) =>
  dispatch({ method, path, body, query: {}, authorization: token ? `Bearer ${token}` : undefined });

async function signUp(person) {
  try {
    return await call('POST', '/auth/register', { ...person, password: PASSWORD });
  } catch (e) {
    if (e.status !== 409) throw e;
    return call('POST', '/auth/login', { email: person.email, password: PASSWORD });
  }
}

async function main() {
  console.log('creating members...');
  const accounts = [];
  for (const p of PEOPLE) accounts.push({ ...(await signUp({ name: p.name, email: p.email })), pattern: p.pattern });

  // Start 12 weeks back so four fortnightly cycles are already due.
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 84);
  const startDate = start.toISOString().slice(0, 10);

  console.log('creating group...');
  const { group } = await call('POST', '/groups', {
    name: 'Sunday Market Hui',
    contributionAmount: 2000000,
    currency: 'VND',
    country: 'VN',
    cycleLengthDays: 14,
    memberCap: 4,
    startDate,
  }, accounts[0].token);

  for (const a of accounts.slice(1)) await call('POST', `/groups/${group.groupId}/join`, {}, a.token);
  const started = await call('POST', `/groups/${group.groupId}/start`, {}, accounts[0].token);
  console.log(`group ${group.groupId} started, due dates:`, started.dueDates.join(', '));

  console.log('writing ledger history...');
  const counters = new Map();
  for (let cycle = 1; cycle <= started.dueDates.length; cycle++) {
    const dueDate = started.dueDates[cycle - 1];
    for (const a of accounts) {
      const onTimeIntent = a.pattern[cycle - 1] === 1;
      const paid = new Date(`${dueDate}T10:00:00Z`);
      paid.setUTCDate(paid.getUTCDate() + (onTimeIntent ? -2 : 4)); // late payers land 4 days after the due date
      const paidAt = paid.toISOString();
      const onTime = isOnTime(paidAt, dueDate);

      await db.put({
        PK: `GROUP#${group.groupId}`,
        SK: `CONTRIB#${String(cycle).padStart(3, '0')}#${a.user.userId}`,
        groupId: group.groupId, groupName: group.name,
        userId: a.user.userId, userName: a.user.name,
        cycle, amount: group.contributionAmount, currency: group.currency,
        dueDate, paidAt, onTime,
      });

      const c = counters.get(a.user.userId) || { total: 0, onTime: 0 };
      c.total++; c.onTime += onTime ? 1 : 0;
      counters.set(a.user.userId, c);
    }
  }

  for (const [userId, c] of counters) {
    await db.update({
      Key: { PK: `USER#${userId}`, SK: 'PROFILE' },
      UpdateExpression: 'SET contribCount = :t, onTimeCount = :o',
      ExpressionAttributeValues: { ':t': c.total, ':o': c.onTime },
    });
  }

  console.log('\nseeded. sign in with any of these / password ' + PASSWORD);
  for (const a of accounts) {
    const c = counters.get(a.user.userId);
    console.log(`  ${a.user.email.padEnd(20)} reliability ${reliability(c.onTime, c.total)} (${c.onTime}/${c.total} on time)`);
  }
  console.log(`\ngroup url: /group/${group.groupId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
