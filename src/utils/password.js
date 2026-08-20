const crypto = require("node:crypto");

// scrypt e' deliberadamente lento/caro em memoria, o que torna ataques de
// forca bruta offline (ex.: se o hash vazar do banco) muito mais caros do
// que com sha256/md5. Cada senha recebe um salt aleatorio proprio, entao
// duas contas com a mesma senha nunca geram o mesmo hash.
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const derivedKey = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== "string") return false;

  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  const [, salt, hashHex] = parts;

  try {
    const expected = Buffer.from(hashHex, "hex");
    const candidate = crypto.scryptSync(String(password || ""), salt, expected.length);
    // timingSafeEqual evita que diferencas no tempo de comparacao vazem
    // quantos bytes do hash estavam corretos.
    return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
  } catch (error) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
