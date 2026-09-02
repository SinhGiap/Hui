'use strict';
const crypto = require('crypto');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('./db');
const { hashPassword, verifyPassword, sign, readToken } = require('./auth');
const { reliability, cycleDueDates, shuffle, currentCycle, isOnTime } = require('./core');
const { publicHolidays, convert } = require('./external');
const { runReport, liveReport } = require('./analytics');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET;
const CDN_DOMAIN = process.env.CDN_DOMAIN;

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
  const password = str(body, 'password', { min: 8, max: 200 });

  const userId = id();
  const now = new Date().toISOString();
  const user = { PK: `USER#${userId}`, SK: 'PROFILE', userId, email, name, passwordHash: hashPassword(password), onTimeCount: 0, contribCount: 0, createdAt: now };

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
  return { token: sign(profile), user: publicUser(profile) };
}

const me = async ({ user }) => ({ user: publicUser(await loadProfile(user.sub)) });

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

async function myGroups({ user }) {
  const mirrors = await db.query(`USER#${user.sub}`, 'GROUP#');
  const groups = await Promise.all(mirrors.map((m) => loadGroup(m.groupId)));
  return { groups: groups.map((g) => ({ ...g, currentCycle: g.dueDates.length ? currentCycle(g.dueDates) : 0 })) };
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

  const contributions = await db.query(`GROUP#${params.id}`, 'CONTRIB#');
  const cycle = group.dueDates.length ? currentCycle(group.dueDates) : 0;
  const converted = await convert(group.contributionAmount, group.currency, (query.display || '').toUpperCase()).catch(() => null);

  return {
    group: { ...group, currentCycle: cycle, complete: group.dueDates.length > 0 && cycle > group.dueDates.length },
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
  if (group.status !== 'ACTIVE') throw new HttpError(409, 'this group is not collecting contributions yet');
  await requireMember(params.id, user.sub);

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
    return { source: 'athena', ...(await runReport(params.id)) };
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
  ['GET', '/groups', myGroups, false],
  ['POST', '/groups', createGroup, false],
  ['GET', '/groups/:id', groupDetail, false],
  ['POST', '/groups/:id/join', joinGroup, false],
  ['POST', '/groups/:id/start', startGroup, false],
  ['POST', '/groups/:id/contributions', addContribution, false],
  ['GET', '/groups/:id/ledger', ledger, false],
  ['GET', '/groups/:id/report', report, false],
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
