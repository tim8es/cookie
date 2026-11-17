import { Pool } from "pg";
import { issueStagingGrant, revokeStagingGrant } from "./staging.js";

if (process.env.COOKIE_OPERATOR_STAGING_PUBLICATION !== "synthetic-only-acknowledged" ||
    !process.env.DATABASE_URL)
  throw new Error("Explicit staging operator acknowledgement and DATABASE_URL required");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 3000 });
try {
  const tenant = process.env.COOKIE_STAGING_TENANT_ID ?? "";
  const action = process.argv[2];
  if (action === "issue") {
    const cap = process.env.COOKIE_STAGING_SEAT_LIMIT ?? "";
    if (!/^[1-9][0-9]*$/.test(cap)) throw new Error("Invalid capacity");
    const grantId = await issueStagingGrant(pool, tenant, Number(cap), process.env.COOKIE_STAGING_EXPIRES_AT ?? "");
    process.stdout.write(JSON.stringify({ grantId, tenant, mode: "controlled-staging-only" }) + "\n");
  } else if (action === "revoke") {
    await revokeStagingGrant(pool, tenant);
    process.stdout.write("Staging grant revoke requested.\n");
  } else throw new Error("Expected issue or revoke");
} catch {
  process.stderr.write("Staging publication grant operation rejected.\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}
