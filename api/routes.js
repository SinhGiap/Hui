'use strict';
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('./db');
const { hashPassword, verifyPassword, sign, readToken, passwordProblem, signRecord, recordIntact } = require('./auth');
const { reliability, cycleDueDates, shuffle, currentCycle, isOnTime } = require('./core');
const { publicHolidays, convert } = require('./external');
const { runReport, liveReport } = require('./analytics');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET;
const CDN_DOMAIN = process.env.CDN_DOMAIN;
const DEMO_MODE = process.env.DEMO_MODE === '1';   // demo clock route, off unless explicitly enabled

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => { throw new HttpError(400, m); };
const id = () => crypto.randomUUID();

// --- validation helpers: each one guards a trust boundary ---
function str(body, field, { max = 200, min = 1 } = {}) {
  const v = body[field];
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) bad(`${field} must be a string of ${min}-${max} characters`);
  return v.trim();
}
function num(body, field, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const v = Number(body[field]);
  if (!Number.isFinite(v) || v < min || v > max) bad(`${field} must be a number between ${min} and ${max}`);
  if (integer && !Number.isInteger(v)) bad(`${field} must be a whole number`);
  return v;
}
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const profileKey = (userId) => [`USER#${userId}`, 'PROFILE'];

async function loadProfile(userId) {
  const p = await db.get(...profileKey(userId));
  if (!p) throw new HttpError(404, 'user not found');
  // An account row edited straight in the DynamoDB console no longer matches its
  // signature, so the app refuses to act on it rather than trusting the change.
  if (!recordIntact(p)) throw new HttpError(409, 'this account record has been modified outside the application');
  return p;
}
const publicUser = (p) => ({
  userId: p.userId,
  name: p.name,
  email: p.email,
  onTimeCount: p.onTimeCount || 0,
  contribCount: p.contribCount || 0,
  reliability: reliability(p.onTimeCount || 0, p.contribCount || 0),
});

async function loadGroup(groupId) {
  const g = await db.get(`GROUP#${groupId}`, 'META');
  if (!g) throw new HttpError(404, 'group not found');
  return g;
}
async function requireMember(groupId, userId) {
  const m = await db.get(`GROUP#${groupId}`, `MEMBER#${userId}`);
  if (!m) throw new HttpError(403, 'you are not a member of this group');
  return m;
}

// ---------------------------------------------------------------- handlers

async function register({ body }) {
  const email = str(body, 'email', { max: 120 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('email is not valid');
  const name = str(body, 'name', { max: 80 });
  const password = str(body, 'password', { min: 1, max: 200 });
  const weak = passwordProblem(password);
  if (weak) bad(weak);

  const userId = id();
  const now = new Date().toISOString();
  const user = { PK: `USER#${userId}`, SK: 'PROFILE', userId, email, name, passwordHash: hashPassword(password), onTimeCount: 0, contribCount: 0, createdAt: now };
  user.sig = signRecord(user);

  try {
    // Both rows land or neither does, so an email can never map to a half-made user.
    await db.transact([
      { Put: { TableName: db.TABLE, Item: user, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: db.TABLE, Item: { PK: `EMAIL#${email}`, SK: 'USER', userId }, ConditionExpression: 'attribute_not_exists(PK)' } },
    ]);
  } catch (e) {
    if (e.name === 'TransactionCanceledException') throw new HttpError(409, 'that email is already registered');
    throw e;
  }
  return { token: sign(user), user: publicUser(user) };
}

async function login({ body }) {
  const email = str(body, 'email', { max: 120 }).toLowerCase();
  const password = str(body, 'password', { min: 1, max: 200 });
  const lookup = await db.get(`EMAIL#${email}`, 'USER');
  // One error message for both failure modes, so the response cannot be used to
  // enumerate which emails are registered.
  const profile = lookup && (await db.get(...profileKey(lookup.userId)));
  if (!profile || !verifyPassword(password, profile.passwordHash)) throw new HttpError(401, 'email or password is incorrect');
  // Check the signature here too, not just in loadProfile. Otherwise swapping a
  // passwordHash straight into the table would still mint a valid session, which
  // is precisely the attack the signature exists to stop.
  if (!recordIntact(profile)) throw new HttpError(409, 'this account record has been modified outside the application');
  return { token: sign(profile), user: publicUser(profile) };
}

const me = async ({ user }) => ({ user: publicUser(await loadProfile(user.sub)) });

// Every account write re-signs the row, so a legitimate change keeps the record
// verifiable while a console edit does not.
const reSign = (next, UpdateExpression, ExpressionAttributeValues, ExpressionAttributeNames) => db.update({
  Key: { PK: `USER#${next.userId}`, SK: 'PROFILE' },
  UpdateExpression,
  ExpressionAttributeValues: { ...ExpressionAttributeValues, ':s': signRecord(next) },
  ...(ExpressionAttributeNames ? { ExpressionAttributeNames } : {}),
});

async function updateProfile({ body, user }) {
  const name = str(body, 'name', { max: 80 });
  const profile = await loadProfile(user.sub);
  const next = { ...profile, name };
  await reSign(next, 'SET #n = :n, sig = :s', { ':n': name }, { '#n': 'name' });
  // The JWT carries the display name, so hand back a fresh one rather than
  // leaving the nav showing the old name until the token expires.
  return { user: publicUser(next), token: sign(next) };
}

async function changePassword({ body, user }) {
  const currentPassword = str(body, 'currentPassword', { min: 1, max: 200 });
  const newPassword = str(body, 'newPassword', { min: 1, max: 200 });
  const profile = await loadProfile(user.sub);
  if (!verifyPassword(currentPassword, profile.passwordHash)) throw new HttpError(403, 'your current password is not correct');
  const weak = passwordProblem(newPassword);
  if (weak) bad(weak);
  if (verifyPassword(newPassword, profile.passwordHash)) bad('the new password must be different from the current one');

  const next = { ...profile, passwordHash: hashPassword(newPassword) };
  await reSign(next, 'SET passwordHash = :p, sig = :s', { ':p': next.passwordHash });
  return { changed: true };
}

// ponytail: no emailed token. SES earns no marks here and cannot reach the
// @example.com demo accounts from the sandbox, and the reset was accepted without
// verification - so anyone who knows a registered address can set its password.
// That is a demo affordance, not a production reset.
async function resetPassword({ body }) {
  const email = str(body, 'email', { max: 120 }).toLowerCase();
  const password = str(body, 'password', { min: 1, max: 200 });
  const weak = passwordProblem(password);
  if (weak) bad(weak);

  const lookup = await db.get(`EMAIL#${email}`, 'USER');
  if (!lookup) throw new HttpError(404, 'no account uses that email address');
  const profile = await loadProfile(lookup.userId);
  const next = { ...profile, passwordHash: hashPassword(password) };
  await reSign(next, 'SET passwordHash = :p, sig = :s', { ':p': next.passwordHash });
  return { token: sign(next), user: publicUser(next) };
}

async function createGroup({ body, user }) {
  const name = str(body, 'name', { max: 80 });
  const contributionAmount = num(body, 'contributionAmount', { min: 1, max: 1e9 });
  const currency = str(body, 'currency', { min: 3, max: 3 }).toUpperCase();
  if (!CURRENCY.test(currency)) bad('currency must be a 3-letter code such as VND');
  const country = str(body, 'country', { min: 2, max: 2 }).toUpperCase();
  if (!COUNTRY.test(country)) bad('country must be a 2-letter code such as VN');
  const cycleLengthDays = num(body, 'cycleLengthDays', { min: 1, max: 90, integer: true });
  const memberCap = num(body, 'memberCap', { min: 2, max: 30, integer: true });
  const startDate = str(body, 'startDate', { min: 10, max: 10 });
  if (!DATE.test(startDate)) bad('startDate must be YYYY-MM-DD');

  const profile = await loadProfile(user.sub);
  const groupId = id();
  const now = new Date().toISOString();
  const group = {
    PK: `GROUP#${groupId}`, SK: 'META', groupId, name, ownerId: user.sub, ownerName: profile.name,
    contributionAmount, currency, country, cycleLengthDays, memberCap,
    memberCount: 1, status: 'OPEN', startDate, dueDates: [], payoutOrder: [], createdAt: now,
  };
  await db.transact([
    { Put: { TableName: db.TABLE, Item: group, ConditionExpression: 'attribute_not_exists(PK)' } },
    { Put: { TableName: db.TABLE, Item: { PK: `GROUP#${groupId}`, SK: `MEMBER#${user.sub}`, groupId, userId: user.sub, userName: profile.name, joinedAt: now } } },
    { Put: { TableName: db.TABLE, Item: { PK: `USER#${user.sub}`, SK: `GROUP#${groupId}`, groupId, groupName: name, joinedAt: now } } },
  ]);
  return { group };
}

// currentCycle and complete are derived, never stored, so the list and the detail
// view have to derive them the same way - a finished circle that reads "Everyone
// has been paid" on its own page must not read "Cycle 3 of 2" in the list.
function withProgress(g) {
  const cycle = g.dueDates.length ? currentCycle(g.dueDates) : 0;
  return { ...g, currentCycle: cycle, complete: g.dueDates.length > 0 && cycle > g.dueDates.length };
}

async function myGroups({ user }) {
  const mirrors = await db.query(`USER#${user.sub}`, 'GROUP#');
  const groups = await Promise.all(mirrors.map((m) => loadGroup(m.groupId)));
  return { groups: groups.map(withProgress) };
}

async function groupDetail({ params, query, user }) {
  const group = await loadGroup(params.id);
  const rows = await db.query(`GROUP#${params.id}`, 'MEMBER#');
  // Groups are single digits in size by nature, so N point reads beats a GSI.
  const members = await Promise.all(rows.map(async (m) => {
    const p = await db.get(...profileKey(m.userId));
    const position = group.payoutOrder.indexOf(m.userId);
    return { ...publicUser(p), joinedAt: m.joinedAt, payoutPosition: position === -1 ? null : position + 1 };
  }));

  const rawContributions = await db.query(`GROUP#${params.id}`, 'CONTRIB#');
  // CloudFront is the fast path, but Learner Lab denies it outright in some
  // accounts, so fall back to a presigned GET. Signing is local HMAC with no API
  // call, so doing it per row costs nothing worth optimising.
  const contributions = await Promise.all(rawContributions.map(async (c) => ({
    ...c,
    evidenceUrl: !c.evidenceKey ? null
      : CDN_DOMAIN ? `https://${CDN_DOMAIN}/${c.evidenceKey}`
        : await getSignedUrl(s3, new GetObjectCommand({ Bucket: EVIDENCE_BUCKET, Key: c.evidenceKey }), { expiresIn: 3600 }),
  })));
  const converted = await convert(group.contributionAmount, group.currency, (query.display || '').toUpperCase()).catch(() => null);

  return {
    group: withProgress(group),
    demo: DEMO_MODE,
    isMember: members.some((m) => m.userId === user.sub),
    members: members.sort((a, b) => (a.payoutPosition || 99) - (b.payoutPosition || 99)),
    contributions,
    converted,
    pot: group.contributionAmount * group.memberCount,
  };
}

async function joinGroup({ params, user }) {
  const group = await loadGroup(params.id);
  if (group.status !== 'OPEN') throw new HttpError(409, 'this group has already started');
  if (await db.get(`GROUP#${params.id}`, `MEMBER#${user.sub}`)) throw new HttpError(409, 'you are already a member');
  const profile = await loadProfile(user.sub);
  const now = new Date().toISOString();

  try {
    // The seat-count check rides in the same transaction as the join, so two
    // people taking the last seat at once cannot both get in.
    await db.transact([
      { Update: {
        TableName: db.TABLE, Key: { PK: `GROUP#${params.id}`, SK: 'META' },
        UpdateExpression: 'SET memberCount = memberCount + :one',
        ConditionExpression: 'memberCount < memberCap AND #s = :open',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':one': 1, ':open': 'OPEN' },
      } },
      { Put: { TableName: db.TABLE, Item: { PK: `GROUP#${params.id}`, SK: `MEMBER#${user.sub}`, groupId: params.id, userId: user.sub, userName: profile.name, joinedAt: now }, ConditionExpression: 'attribute_not_exists(SK)' } },
      { Put: { TableName: db.TABLE, Item: { PK: `USER#${user.sub}`, SK: `GROUP#${params.id}`, groupId: params.id, groupName: group.name, joinedAt: now } } },
    ]);
  } catch (e) {
    if (e.name === 'TransactionCanceledException') throw new HttpError(409, 'the group is full or no longer open');
    throw e;
  }
  return { joined: true };
}

async function startGroup({ params, user }) {
  const group = await loadGroup(params.id);
  if (group.ownerId !== user.sub) throw new HttpError(403, 'only the group organiser can start the rotation');
  if (group.status !== 'OPEN') throw new HttpError(409, 'this group has already started');
  if (group.memberCount < 2) throw new HttpError(409, 'a rotation needs at least two members');

  const members = await db.query(`GROUP#${params.id}`, 'MEMBER#');
  // One cycle per member: the pot goes around exactly once.
  const payoutOrder = shuffle(members.map((m) => m.userId));
  const firstYear = Number(group.startDate.slice(0, 4));
  const holidays = await publicHolidays(group.country, [firstYear, firstYear + 1]).catch(() => new Set());
  const dueDates = cycleDueDates(group.startDate, group.cycleLengthDays, members.length, holidays);

  await db.update({
    Key: { PK: `GROUP#${params.id}`, SK: 'META' },
    UpdateExpression: 'SET #s = :active, payoutOrder = :order, dueDates = :dates, startedAt = :now',
    ConditionExpression: '#s = :open',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':active': 'ACTIVE', ':open': 'OPEN', ':order': payoutOrder, ':dates': dueDates, ':now': new Date().toISOString() },
  });
  return { status: 'ACTIVE', payoutOrder, dueDates };
}

async function addContribution({ params, body, user }) {
  const group = await loadGroup(params.id);
  // Authorise before reporting state: a non-member asking about a group that has
  // not started should be told they are not a member, not that it is not
  // collecting yet.
  await requireMember(params.id, user.sub);
  if (group.status !== 'ACTIVE') throw new HttpError(409, 'this group is not collecting contributions yet');

  const cycle = num(body, 'cycle', { min: 1, max: group.dueDates.length, integer: true });
  const amount = num(body, 'amount', { min: 1, max: 1e9 });
  if (amount !== group.contributionAmount) bad(`this group contributes ${group.contributionAmount} ${group.currency} per cycle`);
  const evidenceKey = body.evidenceKey ? str(body, 'evidenceKey', { max: 300 }) : undefined;

  const profile = await loadProfile(user.sub);
  const paidAt = new Date().toISOString();
  const dueDate = group.dueDates[cycle - 1];
  const onTime = isOnTime(paidAt, dueDate);

  try {
    // The ledger row and the reliability counters move together: a payment can
    // never be recorded without being scored, or be scored twice.
    await db.transact([
      { Put: {
        TableName: db.TABLE,
        Item: { PK: `GROUP#${params.id}`, SK: `CONTRIB#${String(cycle).padStart(3, '0')}#${user.sub}`, groupId: params.id, groupName: group.name, userId: user.sub, userName: profile.name, cycle, amount, currency: group.currency, dueDate, paidAt, onTime, evidenceKey },
        ConditionExpression: 'attribute_not_exists(SK)',
      } },
      { Update: {
        TableName: db.TABLE, Key: { PK: `USER#${user.sub}`, SK: 'PROFILE' },
        UpdateExpression: 'ADD contribCount :one, onTimeCount :hit',
        ExpressionAttributeValues: { ':one': 1, ':hit': onTime ? 1 : 0 },
      } },
    ]);
  } catch (e) {
    if (e.name === 'TransactionCanceledException') throw new HttpError(409, `you have already logged a contribution for cycle ${cycle}`);
    throw e;
  }

  return {
    logged: true, cycle, onTime, dueDate,
    reliability: reliability((profile.onTimeCount || 0) + (onTime ? 1 : 0), (profile.contribCount || 0) + 1),
    recipient: group.payoutOrder[cycle - 1] || null,
  };
}

async function ledger({ params, query }) {
  await loadGroup(params.id);
  const prefix = query.cycle ? `CONTRIB#${String(Number(query.cycle)).padStart(3, '0')}#` : 'CONTRIB#';
  return { contributions: await db.query(`GROUP#${params.id}`, prefix) };
}

// The browser uploads payment evidence straight to S3 with this URL, so image
// bytes never pass through Lambda's 6 MB payload limit.
// ---------------------------------------------------------------------------
// DEMO ONLY. Reliability only becomes visible once payments land on either side
// of a due date, and nobody can wait a fortnight during a demo. The server clock
// cannot move, so this moves the due dates instead: one press brings the current
// cycle's deadline to today (pay now = on time), the next shoves it three days
// into the past (pay now = late).
//
// ponytail: gated on DEMO_MODE rather than deleted before submission, so the
// marker can drive it. Unset DEMO_MODE and the route 404s like it was never
// there. Only rewrites dueDates - contributions keep the dueDate stamped on them
// when they were written, so nothing already logged is rescored.
const shiftDay = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysApart = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

async function demoAdvance({ params, user }) {
  if (!DEMO_MODE) throw new HttpError(404, `no route for POST /groups/${params.id}/demo/advance`);
  const group = await loadGroup(params.id);
  if (group.ownerId !== user.sub) throw new HttpError(403, 'only the organiser can move the demo clock');
  if (group.status !== 'ACTIVE') throw new HttpError(409, 'start the rotation first');

  const today = new Date().toISOString().slice(0, 10);
  if (!group.dueDates.length) throw new HttpError(409, 'start the rotation first');
  const cycle = currentCycle(group.dueDates);
  const last = group.dueDates[group.dueDates.length - 1];

  // Signed days to add to every due date:
  //   past the end  -> forward, so the final cycle is due today again. Without
  //                    this the circle reads complete, the control disappears and
  //                    the demo is stranded with no way back.
  //   future deadline-> back onto today, so paying now scores on time.
  //   today or behind-> back three more days, so paying now scores late.
  const delta = cycle > group.dueDates.length ? daysApart(today, last)
    : group.dueDates[cycle - 1] > today ? -daysApart(group.dueDates[cycle - 1], today)
      : -3;
  const dueDates = group.dueDates.map((d) => shiftDay(d, delta));

  await db.update({
    Key: { PK: `GROUP#${params.id}`, SK: 'META' },
    UpdateExpression: 'SET dueDates = :d',
    ExpressionAttributeValues: { ':d': dueDates },
  });

  return {
    dueDates,
    movedBackDays: -delta,
    currentCycle: currentCycle(dueDates),
    // The demo operator's actual question: did that press put a deadline behind
    // us, so the next payment against it scores late?
    overdueCycles: dueDates.filter((d) => d < today).length,
  };
}

async function presign({ body, user }) {
  const contentType = str(body, 'contentType', { max: 60 });
  if (!/^image\/(png|jpe?g|webp)$/.test(contentType)) bad('evidence must be a PNG, JPEG or WebP image');
  const groupId = str(body, 'groupId', { max: 60 });
  await requireMember(groupId, user.sub);

  const ext = contentType.split('/')[1].replace('jpeg', 'jpg');
  const key = `evidence/${groupId}/${user.sub}/${id()}.${ext}`;
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: EVIDENCE_BUCKET, Key: key, ContentType: contentType }), { expiresIn: 300 });
  return { uploadUrl, key, viewUrl: CDN_DOMAIN ? `https://${CDN_DOMAIN}/${key}` : null };
}

// Athena is the graded path; the DynamoDB rollup is the fallback so a demo still
// has numbers before the first nightly export has landed.
async function report({ params, query }) {
  await loadGroup(params.id);
  if (query.source === 'live') return { source: 'dynamodb', ...(await liveReport(params.id)) };
  try {
    const rows = await runReport(params.id);
    // Athena succeeds with zero rows for a circle the nightly export has not
    // picked up yet, so an empty result is a miss, not an answer - fall through
    // to the live rollup rather than showing a blank report.
    if (rows.byMember.length) return { source: 'athena', ...rows };
    return { source: 'dynamodb', note: 'no nightly export for this group yet; showing live DynamoDB rollup', ...(await liveReport(params.id)) };
  } catch (e) {
    return { source: 'dynamodb', note: `Athena unavailable (${e.message}); showing live DynamoDB rollup`, ...(await liveReport(params.id)) };
  }
}

// ------------------------------------------------------------------ router

const compile = (path) => new RegExp(`^${path.replace(/:[^/]+/g, '([^/]+)')}/?$`);
const paramNames = (path) => (path.match(/:[^/]+/g) || []).map((p) => p.slice(1));

const table = [
  ['POST', '/auth/register', register, true],
  ['POST', '/auth/login', login, true],
  ['GET', '/me', me, false],
  ['POST', '/me', updateProfile, false],
  ['POST', '/me/password', changePassword, false],
  ['POST', '/auth/reset', resetPassword, true],
  ['GET', '/groups', myGroups, false],
  ['POST', '/groups', createGroup, false],
  ['GET', '/groups/:id', groupDetail, false],
  ['POST', '/groups/:id/join', joinGroup, false],
  ['POST', '/groups/:id/start', startGroup, false],
  ['POST', '/groups/:id/contributions', addContribution, false],
  ['GET', '/groups/:id/ledger', ledger, false],
  ['GET', '/groups/:id/report', report, false],
  ['POST', '/groups/:id/demo/advance', demoAdvance, false],
  ['POST', '/uploads/presign', presign, false],
].map(([method, path, handler, isPublic]) => ({ method, path, handler, isPublic, re: compile(path), names: paramNames(path) }));

async function dispatch({ method, path, body, query, authorization }) {
  for (const route of table) {
    if (route.method !== method) continue;
    const match = route.re.exec(path);
    if (!match) continue;

    const user = readToken(authorization);
    if (!route.isPublic && !user) throw new HttpError(401, 'sign in to continue');
    const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
    return route.handler({ params, body: body || {}, query: query || {}, user });
  }
  throw new HttpError(404, `no route for ${method} ${path}`);
}

module.exports = { dispatch, HttpError, table };
