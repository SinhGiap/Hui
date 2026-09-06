'use strict';
// End-to-end check against a deployed stack: drives a whole circle through the
// real API Gateway, so it proves gateway -> Lambda -> DynamoDB/S3 and the
// third-party APIs, not just that something answers on port 443.
//
// A Learner Lab reset rebuilds everything, and "it deployed" is not the same as
// "it works", so this is the thing to run after `npm run deploy`.
//
// Run: npm run smoke
const assert = require('assert');

const BASE = process.env.API_BASE;
const PASSWORD = 'Rosca!2026';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let failed = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ok    ${label}`); } catch (e) { failed++; console.log(`  FAIL  ${label}: ${e.message}`); }
};

async function call(method, path, { body, token, expect = 200 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  if (res.status !== expect) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

const login = (email) => call('POST', '/auth/login', { body: { email, password: PASSWORD } });

async function main() {
  if (!BASE || BASE.includes('localhost')) throw new Error(`API_BASE points at "${BASE}" - deploy first`);
  console.log(`smoke test against ${BASE}\n`);

  console.log('auth');
  const mai = await login('mai@example.com');
  const huong = await login('huong@example.com');
  const duc = await login('duc@example.com');
  const linh = await login('linh@example.com');
  check('three members signed in', () => assert(mai.token && huong.token && duc.token));
  await call('POST', '/auth/login', { body: { email: 'mai@example.com', password: 'wrong' }, expect: 401 });
  console.log('  ok    wrong password gives 401');
  await call('GET', '/groups', { expect: 401 });
  console.log('  ok    no token gives 401');

  const { user } = await call('GET', '/me', { token: mai.token });
  check('/me returns a reliability score', () => assert(typeof user.reliability === 'number'));

  console.log('\ncircle lifecycle');
  const startDate = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const { group } = await call('POST', '/groups', {
    token: linh.token,
    body: { name: `Smoke ${new Date().toISOString().slice(11, 19)}`, contributionAmount: 500000, currency: 'VND', country: 'VN', cycleLengthDays: 14, memberCap: 3, startDate },
  });
  check('circle created', () => assert(group.groupId && group.status === 'OPEN'));

  await call('POST', `/groups/${group.groupId}/join`, { token: huong.token });
  await call('POST', `/groups/${group.groupId}/join`, { token: duc.token });
  console.log('  ok    two members joined');

  await call('POST', `/groups/${group.groupId}/join`, { token: huong.token, expect: 409 });
  console.log('  ok    joining twice gives 409');

  await call('POST', `/groups/${group.groupId}/contributions`, { token: linh.token, body: { cycle: 1, amount: 500000 }, expect: 409 });
  console.log('  ok    paying before start gives 409');

  const started = await call('POST', `/groups/${group.groupId}/start`, { token: linh.token });
  check('rotation started with a due date per member', () => assert.equal(started.dueDates.length, 3));
  check('payout order covers every member exactly once', () => assert.equal(new Set(started.payoutOrder).size, 3));

  console.log('\nledger and scoring');
  const paid = await call('POST', `/groups/${group.groupId}/contributions`, { token: linh.token, body: { cycle: 1, amount: 500000 } });
  check('contribution logged and scored', () => assert(paid.logged === true && typeof paid.onTime === 'boolean'));
  check('reliability recomputed', () => assert(typeof paid.reliability === 'number'));

  await call('POST', `/groups/${group.groupId}/contributions`, { token: linh.token, body: { cycle: 1, amount: 500000 }, expect: 409 });
  console.log('  ok    double payment blocked by the transaction');

  await call('POST', `/groups/${group.groupId}/contributions`, { token: linh.token, body: { cycle: 1, amount: 999 }, expect: 400 });
  console.log('  ok    wrong amount rejected');

  await call('POST', `/groups/${group.groupId}/contributions`, { token: huong.token, body: { cycle: 1, amount: 500000 } });
  const detail = await call('GET', `/groups/${group.groupId}?display=USD`, { token: linh.token });
  check('pot equals one full cycle (3 x 500000)', () => assert.equal(detail.pot, 1500000));
  check('members carry seats and scores', () => assert.equal(detail.members.length, 3));
  check('exchangerate API converted the amount', () => assert(detail.converted && detail.converted.amount > 0));

  console.log('\nreporting');
  const report = await call('GET', `/groups/${group.groupId}/report`, { token: linh.token });
  check('report returns per-cycle rows', () => assert(Array.isArray(report.byCycle) && report.byCycle.length));
  console.log(`  info  report source: ${report.source}`);

  console.log('\ns3 evidence');
  const sign = await call('POST', '/uploads/presign', { token: linh.token, body: { contentType: 'image/png', groupId: group.groupId } });
  check('presigned url issued', () => assert(sign.uploadUrl.startsWith('https://')));
  const put = await fetch(sign.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
  check('image uploaded straight to S3', () => assert.equal(put.status, 200));

  await call('POST', '/uploads/presign', { token: duc.token, body: { contentType: 'application/pdf', groupId: group.groupId }, expect: 400 });
  console.log('  ok    non-image evidence rejected');

  console.log(`\n${failed ? `${failed} CHECK(S) FAILED` : 'all checks passed'} - circle ${group.groupId}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('\nsmoke test aborted:', e.message); process.exit(1); });
