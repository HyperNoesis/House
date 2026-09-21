// auth.js — real password hashing (scrypt) and signed, expiring tokens
// (HMAC-SHA256), using only Node's built-in crypto module. No JWT library
// needed: the token format is `base64(payload).base64(hmac)`, which is
// the same idea as a JWT without pulling in a dependency.

const crypto = require("crypto");

const SECRET = process.env.ILE_AUTH_SECRET || (() => {
  // In production, set ILE_AUTH_SECRET in the environment. We generate a
  // random one at boot as a safe fallback for local/dev use so the server
  // never ships with a hardcoded secret — but note this means tokens
  // become invalid on every restart. That's intentional and safe.
  return crypto.randomBytes(32).toString("hex");
})();

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  // timing-safe comparison
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const hmac = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${hmac}`;
}

function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, hmac] = token.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

function issueToken(user) {
  return sign({
    sub: user.id,
    email: user.email,
    role: user.role,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7, // 7 days
  });
}

module.exports = { hashPassword, verifyPassword, issueToken, verify };
