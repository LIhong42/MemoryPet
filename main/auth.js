// main/auth.js — scrypt-based PIN hashing for the main-window access gate.
//
// 4-digit PINs have a tiny key space (10^4) so hashing only blocks casual
// disk inspection; a determined attacker with the DB file can brute-force
// offline. That's acceptable for this product class — the real protection
// is the lock UX in the renderer, not crypto secrecy.
const crypto = require('node:crypto');

// Scrypt parameters tuned for ~25-40 ms per derive on a modern desktop.
// `maxmem` is generous so first-run doesn't trip Node's default 32 MB cap.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SALT_BYTES = 16;
const KEY_LEN = 32;

// Hash a 4-digit PIN into "<saltHex>$<hashHex>". Caller is expected to
// have validated the shape via isValidPinShape(); we still coerce to a
// string so a non-string input doesn't crash the scrypt call.
function hashPin(pin) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(pin), salt, KEY_LEN, SCRYPT_OPTS);
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Verify a candidate PIN against a previously stored "<saltHex>$<hashHex>".
// Returns false on any shape / parse error — never throws — so an attacker
// can't probe the verifier for stack traces.
function verifyPin(pin, stored) {
  if (typeof stored !== 'string' || !stored.includes('$')) return false;
  const idx = stored.indexOf('$');
  const saltHex = stored.slice(0, idx);
  const hashHex = stored.slice(idx + 1);
  let salt, expected;
  try {
    salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LEN) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(pin), salt, KEY_LEN, SCRYPT_OPTS);
  } catch {
    return false;
  }
  // timingSafeEqual requires equal-length buffers; we've already enforced
  // that above via the KEY_LEN check.
  return crypto.timingSafeEqual(expected, actual);
}

// Reject anything that isn't exactly 4 ASCII digits. The lock UI also
// enforces this, but defense-in-depth on the main-process side keeps a
// tampered renderer from bypassing the gate.
function isValidPinShape(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

module.exports = { hashPin, verifyPin, isValidPinShape, SCRYPT_OPTS };
