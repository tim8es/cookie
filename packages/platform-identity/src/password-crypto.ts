import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Versioned, fixed-cost storage format. Never accept KDF costs from a request
// or from a stored string. OWASP scrypt baseline: N=2^17, r=8, p=1.
const VERSION = "scrypt-v1";
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_PASSWORD_BYTES = 1_024;
const OPTIONS = {
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 160 * 1024 * 1024,
};
const STORED_LENGTH = VERSION.length + 2 + (SALT_BYTES + KEY_BYTES) * 2;

function encodePassword(password: unknown): Buffer | null {
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_BYTES
  ) {
    return null;
  }
  const bytes = Buffer.from(password, "utf8");
  // Reject malformed Unicode rather than silently replacing lone surrogates.
  if (bytes.length > MAX_PASSWORD_BYTES || bytes.toString("utf8") !== password) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}

function deriveKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, OPTIONS, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * Internal credential-storage primitive, not a registration policy or a
 * credential verifier endpoint. Callers must enforce password strength,
 * request limits and bounded concurrent KDF work before exposing this.
 */
export async function hashPassword(password: unknown): Promise<string> {
  const bytes = encodePassword(password);
  if (!bytes) throw new Error("Invalid password input");
  try {
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(bytes, salt);
    try {
      return [VERSION, salt.toString("hex"), key.toString("hex")].join("$");
    } finally {
      key.fill(0);
    }
  } finally {
    bytes.fill(0);
  }
}

/**
 * Strictly recognize our own storage format and compare fixed-length keys.
 * Operational crypto errors reject; they are not successful verification.
 * The future login service must also avoid account-enumeration timing leaks
 * (including unknown accounts) and handle overload before invoking this.
 */
export async function verifyPassword(
  password: unknown,
  stored: unknown,
): Promise<boolean> {
  if (typeof stored !== "string" || stored.length !== STORED_LENGTH) {
    return false;
  }
  const [version, saltHex, keyHex] = stored.split("$");
  if (
    version !== VERSION ||
    !saltHex ||
    saltHex.length !== SALT_BYTES * 2 ||
    /[^0-9a-f]/.test(saltHex) ||
    !keyHex ||
    keyHex.length !== KEY_BYTES * 2 ||
    /[^0-9a-f]/.test(keyHex)
  ) {
    return false;
  }

  const bytes = encodePassword(password);
  if (!bytes) return false;
  const expected = Buffer.from(keyHex, "hex");
  try {
    const derived = await deriveKey(bytes, Buffer.from(saltHex, "hex"));
    try {
      return timingSafeEqual(expected, derived);
    } finally {
      derived.fill(0);
    }
  } finally {
    bytes.fill(0);
    expected.fill(0);
  }
}
