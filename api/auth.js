'use strict';
// Password hashing uses node's built-in scrypt rather than bcrypt: no native
// module to cross-compile for the Lambda runtime, and scrypt is the stronger KDF.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';
const TOKEN_TTL = '12h';

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(plain, salt, 64).toString('hex')}`;
}

function verifyPassword(plain, stored) {
  const [salt, key] = String(stored).split(':');
  if (!salt || !key) return false;
  const expected = Buffer.from(key, 'hex');
  const actual = crypto.scryptSync(plain, salt, 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// One place, so register, reset and change-password cannot drift apart.
function passwordProblem(plain) {
  const p = String(plain || '');
  if (p.length < 8) return 'password must be at least 8 characters';
  if (p.length > 200) return 'password must be at most 200 characters';
  if (!/[a-z]/.test(p)) return 'password needs a lowercase letter';
  if (!/[A-Z]/.test(p)) return 'password needs an uppercase letter';
  if (!/[0-9]/.test(p)) return 'password needs a digit';
  return null;
}

// Tamper-evidence: a row edited straight in the table no longer matches its
// signature, and the application refuses or flags it.
//
// IAM is the real control - nobody should hold write access to the production
// table - but the lab cannot create per-function roles, so this is the
// defence-in-depth layer rather than the only one.
//
// Only rows the application never rewrites are signed. A signature over a
// mutable field has to be recomputed on every write, and recomputing it from a
// stale read silently locks the row out of its own application - a worse failure
// than the tampering it defends against. So the counters stay unsigned and move
// by atomic ADD, and group settings are not signed at all. The reliability score
// is still checkable, because it is derivable from the signed ledger.
//
// PK and SK are signed so a valid row copied into another partition or sort key
// stops verifying there.
const FIELDS = {
  profile: ['PK', 'SK', 'userId', 'email', 'name', 'passwordHash'],
  // The ledger. Written once and never updated, which is what makes it safe to
  // sign. evidenceKey is included: groupDetail presigns a GET for whatever key
  // the row carries, so an unsigned key is a read of any object in the bucket.
  contrib: ['PK', 'SK', 'groupId', 'userId', 'userName', 'cycle', 'amount',
    'currency', 'dueDate', 'paidAt', 'onTime', 'evidenceKey'],
  // Without this, repointing EMAIL#<addr> at another userId logs you in as them.
  email: ['PK', 'SK', 'userId'],
};

// JSON.stringify rather than template interpolation, so the signature binds the
// stored type: number 0 and string "0" must not hash alike, or swapping a
// counter's DynamoDB type turns arithmetic into string concatenation.
const signRecord = (rec, kind = 'profile') => crypto
  .createHmac('sha256', SECRET)
  .update(`${kind} ` + FIELDS[kind].map((f) => `${f}=${JSON.stringify(rec[f] ?? null)}`).join('\u0000'))
  .digest('hex');

function recordIntact(rec, kind = 'profile') {
  // An unknown kind must fail closed, not throw a 500 out of a read path.
  if (!FIELDS[kind] || !rec || typeof rec.sig !== 'string') return false;
  const expected = Buffer.from(signRecord(rec, kind), 'hex');
  const actual = Buffer.from(rec.sig, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// The ledger is the only signed row read on hot paths, and it is checked in four
// places (two that flag, two that exclude). Naming it once keeps the record kind
// and the policy from drifting apart across them.
const contribIntact = (c) => recordIntact(c, 'contrib');

const sign = (user) => jwt.sign({ sub: user.userId, email: user.email, name: user.name }, SECRET, { expiresIn: TOKEN_TTL });

function readToken(header) {
  const raw = (header || '').replace(/^Bearer\s+/i, '');
  if (!raw) return null;
  try {
    return jwt.verify(raw, SECRET);
  } catch {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, sign, readToken, passwordProblem, signRecord, recordIntact, contribIntact };
