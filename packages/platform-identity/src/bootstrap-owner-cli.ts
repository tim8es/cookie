import { Pool } from "pg";

import {
  OwnerWorkspaceProvisionError,
  provisionOwnerWorkspace,
} from "./provision-owner-workspace.js";

/**
 * Privileged local/self-host operator command. Not accessible over HTTP.
 * No token or real login session is issued: verified phone/Telegram login and
 * the real customer Booking API remain separate release gates.
 */
const env = process.env;
if (env.COOKIE_OPERATOR_BOOTSTRAP !== "acknowledged") {
  throw new Error("COOKIE_OPERATOR_BOOTSTRAP=acknowledged is required");
}
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  application_name: "cookie-owner-operator-bootstrap",
  max: 2,
  connectionTimeoutMillis: 3_000,
});
try {
  const identityId = env.COOKIE_OWNER_IDENTITY_ID ?? "";
  // Identity creation is restricted to this DB-privileged operator command.
  // Never make this step available to caller-supplied HTTP identity IDs.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identityId)) {
    throw new OwnerWorkspaceProvisionError("INVALID_INPUT");
  }
  await pool.query(
    "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid) ON CONFLICT (id) DO NOTHING",
    [identityId],
  );
  const result = await provisionOwnerWorkspace(pool, {
    ownerIdentityId: identityId,
    idempotencyKey: env.COOKIE_OWNER_SETUP_KEY ?? "",
    organizationName: env.COOKIE_OWNER_ORGANIZATION ?? "",
    locationName: env.COOKIE_OWNER_LOCATION ?? "",
    timeZone: env.COOKIE_OWNER_TIME_ZONE ?? "",
  });
  process.stdout.write(JSON.stringify({
    identityId,
    tenantId: result.tenantId,
    locationId: result.locationId,
    replayed: result.replayed,
    note: "Operator provisioning only: no account login or customer Booking API",
  }) + "\n");
} catch (error) {
  const code =
    error instanceof OwnerWorkspaceProvisionError ? error.code : "SETUP_FAILED";
  // Do not leak names, DATABASE_URL, SQL or connection secrets to logs.
  process.stderr.write(`Cookie owner workspace provisioning failed: ${code}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
