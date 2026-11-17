import { Pool } from "pg";
import { createTelegramMiniAppProofVerifier } from "../../platform-identity/src/index.js";
import { provisionStagingCustomer } from "./staging-customer.js";
const env = process.env;
if (
  env.COOKIE_OPERATOR_STAGING_CUSTOMER !== "synthetic-only-acknowledged" ||
  env.COOKIE_TELEGRAM_LINK_CONSENT !== "confirmed" ||
  !env.DATABASE_URL
)
  throw new Error(
    "Explicit staging operator and consent acknowledgement required",
  );
const secret = env.COOKIE_TELEGRAM_USER_HMAC_SECRET ?? "";
if (!/^[0-9a-f]{64}$/i.test(secret))
  throw new Error("Invalid Telegram fingerprint secret");
const verifier = createTelegramMiniAppProofVerifier({
  botToken: env.COOKIE_TELEGRAM_BOT_TOKEN ?? "",
  maxAgeSeconds: 300,
});
let raw = "";
for await (const chunk of process.stdin) {
  raw += String(chunk);
  if (Buffer.byteLength(raw, "utf8") > 8192) throw new Error("Proof too large");
}
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 3000,
});
try {
  const result = await provisionStagingCustomer(
    pool,
    verifier,
    Buffer.from(secret, "hex"),
    {
      tenantId: env.COOKIE_STAGING_TENANT_ID ?? "",
      rawInitData: raw.trim(),
      consentConfirmed: true,
    },
  );
  process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stderr.write("Staging customer provision rejected.\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}
