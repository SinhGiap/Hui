'use strict';
// Password hashing uses node's built-in scrypt rather than bcrypt: no native
// module to cross-compile for the Lambda runtime, and scrypt is the stronger KDF.
// [1] NIST SP 800-63B, "Digital Identity Guidelines: Authentication", 2017.
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

module.exports = { hashPassword, verifyPassword, sign, readToken };
