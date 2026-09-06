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

// Tamper-evidence: editing a name, email or password hash in the console breaks
// the signature and loadProfile refuses the row. Identity fields only - the
// counters move through atomic ADD updates that cannot re-sign in the same write.
const PROFILE_FIELDS = ['userId', 'email', 'name', 'passwordHash'];
const signRecord = (rec) => crypto
  .createHmac('sha256', SECRET)
  .update(PROFILE_FIELDS.map((f) => `${f}=${rec[f] ?? ''}`).join('\u0000'))
  .digest('hex');

function recordIntact(rec) {
  if (!rec || typeof rec.sig !== 'string') return false;
  const expected = Buffer.from(signRecord(rec), 'hex');
  const actual = Buffer.from(rec.sig, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

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

module.exports = { hashPassword, verifyPassword, sign, readToken, passwordProblem, signRecord, recordIntact };
