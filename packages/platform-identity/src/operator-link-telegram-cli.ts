import { Pool } from "pg";

import {
  TrustedOwnerTelegramLinkError,
  linkVerifiedTelegramOwner,
} from "./link-telegram-owner.js";
import { createTelegramMiniAppProofVerifier } from "./telegram-init-data.js";

// Only a DB-privileged operator may link an already provisioned owner.
// Read signed initData from stdin, never from process arguments or logs.
const env = process.env;
if (
  env.COOKIE_OPERATOR_LINK_TELEGRAM !== "acknowledged" ||
  env.COOKIE_TELEGRAM_LINK_CONSENT !== "confirmed"
) {
  throw new Error("Explicit operator authorization and consent are required");
}
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const secretHex = env.COOKIE_TELEGRAM_USER_HMAC_SECRET ?? "";
if (!/^[0-9a-f]{64}$/i.test(secretHex)) {
  throw new Error(
    "A 32-byte independent Telegram user HMAC secret is required",
  );
}
const verifier = createTelegramMiniAppProofVerifier({
  botToken: env.COOKIE_TELEGRAM_BOT_TOKEN ?? "",
  maxAgeSeconds: 300,
});

let input = "";
for await (const chunk of process.stdin) {
  input += String(chunk);
  if (Buffer.byteLength(input, "utf8") > 8192) {
    throw new Error("Telegram initData is too large");
  }
}
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  application_name: "cookie-operator-telegram-owner-link",
  max: 2,
  connectionTimeoutMillis: 3000,
});
try {
  const outcome = await linkVerifiedTelegramOwner(
    pool,
    verifier,
    Buffer.from(secretHex, "hex"),
    {
      tenantId: env.COOKIE_OWNER_TENANT_ID ?? "",
      ownerIdentityId: env.COOKIE_OWNER_IDENTITY_ID ?? "",
      rawInitData: input.trim(),
      consentConfirmed: true,
    },
  );
  process.stdout.write(JSON.stringify(outcome) + "\n");
} catch (error) {
  const code =
    error instanceof TrustedOwnerTelegramLinkError
      ? error.code
      : "LINK_FAILED";
  process.stderr.write(`Telegram owner link failed: ${code}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
