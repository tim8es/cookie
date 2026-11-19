import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { AuthMailPurpose } from "./auth-mail-delivery.js";
import { canonicalRegistrationEmail } from "./email-registration.js";

export function createAuthMailEnvelope(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Invalid auth mail encryption key");
  }
  const secret = Buffer.from(key);
  const aad = (id: string, purpose: AuthMailPurpose) =>
    Buffer.from("kuki-auth-mail-v1:" + id + ":" + purpose, "utf8");

  return {
    seal(id: string, purpose: AuthMailPurpose, address: string): Buffer {
      if (canonicalRegistrationEmail(address) !== address) {
        throw new Error("Invalid auth mail recipient");
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, nonce);
      cipher.setAAD(aad(id, purpose));
      const ciphertext = Buffer.concat([
        cipher.update(address, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    open(id: string, purpose: AuthMailPurpose, sealed: Buffer): string {
      try {
        if (sealed.length < 29 || sealed.length > 282) {
          throw new Error("Invalid envelope");
        }
        const decipher = createDecipheriv(
          "aes-256-gcm",
          secret,
          sealed.subarray(0, 12),
        );
        decipher.setAAD(aad(id, purpose));
        decipher.setAuthTag(sealed.subarray(12, 28));
        const plaintext = Buffer.concat([
          decipher.update(sealed.subarray(28)),
          decipher.final(),
        ]);
        try {
          const address = plaintext.toString("utf8");
          if (canonicalRegistrationEmail(address) !== address) {
            throw new Error("Invalid envelope");
          }
          return address;
        } finally {
          plaintext.fill(0);
        }
      } catch {
        throw new Error("Auth mail envelope authentication failed");
      }
    },
  };
}
