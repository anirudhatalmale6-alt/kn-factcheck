'use strict';
const crypto = require('crypto');

// --- base32 (RFC 4648, no padding) for TOTP secrets ---
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// --- TOTP (RFC 6238, SHA1, 6 digits, 30s step) ---
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}
function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | (hmac[offset + 3]);
  return (bin % 1000000).toString().padStart(6, '0');
}
function totpVerify(secret, token, atSeconds) {
  const t = Math.floor((atSeconds || Date.now() / 1000) / 30);
  const clean = String(token || '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  for (let w = -1; w <= 1; w++) {           // ±30s tolerance
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, t + w)), Buffer.from(clean))) return true;
  }
  return false;
}
function otpauthURL(username, secret, issuer) {
  const label = encodeURIComponent(issuer + ':' + username);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

module.exports = { generateSecret, totpVerify, otpauthURL, base32Encode, base32Decode };
