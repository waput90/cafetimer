// @ts-nocheck
const crypto = require('node:crypto');

function newAccessCode() {
  return crypto.randomBytes(9).toString('base64url');
}

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const normalizedPin = String(pin ?? '');
  const hash = crypto.scryptSync(normalizedPin, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPin(pin, credentials) {
  if (!credentials?.salt || !credentials?.hash) return false;
  const candidate = hashPin(pin, credentials.salt).hash;
  const expectedBuffer = Buffer.from(credentials.hash, 'hex');
  const candidateBuffer = Buffer.from(candidate, 'hex');
  return expectedBuffer.length === candidateBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
}

module.exports = { hashPin, verifyPin, newAccessCode };
