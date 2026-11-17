import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { TelegramMiniAppProofVerifier } from "../../platform-identity/src/telegram-init-data.js";
import { telegramUserFingerprint } from "../../platform-identity/src/telegram-links.js";
import {
  AuthorizationDeniedError,
  type TrustedActor,
} from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CUSTOMER_CONTEXT_PERMISSION = "staging.customer.context.read";
export const CUSTOMER_OFFERS_PERMISSION = "staging.customer.offers.read";

interface LinkInput {
  readonly tenantId: string;
  readonly rawInitData: string;
  readonly consentConfirmed: true;
}
interface CustomerContext {
  readonly tenantId: string;
  readonly customerId: string;
}
interface Existing extends QueryResultRow {
  tenant_id: string;
  identity_id: string;
  id: string;
}
interface Binding extends QueryResultRow {
  customer_id: string;
  identity_id: string;
  telegram_link_id: string;
}

/**
 * Privileged synthetic operator only. Allocate a fresh Identity, Membership,
 * narrowly scoped Client role, Customer and consented link in one transaction.
 * No supplied identity/customer ID, no login-time account creation, no owner
 * or staff role assignment; a previously linked channel is never rebound.
 */
export async function provisionStagingCustomer(
  pool: Pool,
  verifier: TelegramMiniAppProofVerifier,
  secret: Buffer,
  input: LinkInput,
): Promise<CustomerContext> {
  if (
    !input ||
    !UUID.test(input.tenantId) ||
    input.consentConfirmed !== true ||
    typeof input.rawInitData !== "string" ||
    Buffer.byteLength(input.rawInitData, "utf8") > 8192
  )
    throw new Error("Invalid staging customer input");
  const proof = verifier.verify(input.rawInitData);
  if (!proof || proof.channel !== "telegram-mini-app")
    throw new Error("Invalid staging customer proof");
  const hash = telegramUserFingerprint(secret, proof.telegramUserId);
  const client = await pool.connect();
  let discard = true;
  try {
    await client.query("BEGIN");
    discard = false;
    // Same organization then fingerprint lock order as owner link.
    const org = await client.query(
      "SELECT id FROM cookie_tenancy.organizations WHERE id=$1::uuid FOR UPDATE",
      [input.tenantId],
    );
    if (org.rowCount !== 1)
      throw new Error("Staging customer tenant unavailable");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      hash.readBigInt64BE(0).toString(),
    ]);
    const existing = await client.query<Existing>(
      "SELECT tenant_id::text,identity_id::text,id::text FROM cookie_identity.telegram_identity_links WHERE telegram_user_hmac_sha256=$1::bytea AND revoked_at IS NULL ORDER BY tenant_id,id LIMIT 2 FOR SHARE",
      [hash],
    );
    if (existing.rows.length) {
      const link = existing.rows[0]!;
      if (existing.rows.length !== 1 || link.tenant_id !== input.tenantId)
        throw new Error("Staging customer link conflict");
      const binding = await client.query<Binding>(
        "SELECT c.customer_id::text,c.identity_id::text,c.telegram_link_id::text FROM cookie_customers.staging_customer_identities c JOIN cookie_identity.memberships m ON m.tenant_id=c.tenant_id AND m.identity_id=c.identity_id WHERE c.tenant_id=$1::uuid AND c.identity_id=$2::uuid AND c.telegram_link_id=$3::uuid AND m.active",
        [input.tenantId, link.identity_id, link.id],
      );
      if (binding.rowCount !== 1)
        throw new Error("Staging customer link conflict");
      discard = true;
      const committed = await client.query("COMMIT");
      if (committed.command !== "COMMIT")
        throw new Error("Staging customer provision not committed");
      discard = false;
      return {
        tenantId: input.tenantId,
        customerId: binding.rows[0]!.customer_id,
      };
    }
    // Do not turn a revoked proof link into a new account via this tool.
    const revoked = await client.query(
      "SELECT 1 FROM cookie_identity.telegram_identity_links WHERE telegram_user_hmac_sha256=$1::bytea LIMIT 1",
      [hash],
    );
    if (revoked.rowCount)
      throw new Error("Staging customer link requires review");
    const identityId = randomUUID(),
      customerId = randomUUID(),
      roleId = randomUUID(),
      linkId = randomUUID();
    await client.query(
      "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
      [identityId],
    );
    await client.query(
      "INSERT INTO cookie_identity.memberships(tenant_id,identity_id) VALUES($1::uuid,$2::uuid)",
      [input.tenantId, identityId],
    );
    await client.query(
      "INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions) VALUES($1::uuid,$2::uuid,'client','Staging Client',ARRAY[$3::text,$4::text])",
      [input.tenantId, roleId, CUSTOMER_CONTEXT_PERMISSION, CUSTOMER_OFFERS_PERMISSION],
    );
    await client.query(
      "INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
      [input.tenantId, randomUUID(), identityId, roleId],
    );
    await client.query(
      "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1::uuid,$2::uuid)",
      [input.tenantId, customerId],
    );
    await client.query(
      "INSERT INTO cookie_identity.telegram_identity_links(tenant_id,id,identity_id,telegram_user_hmac_sha256,proof_verified_at,consent_confirmed_at) VALUES($1::uuid,$2::uuid,$3::uuid,$4::bytea,to_timestamp($5::bigint),clock_timestamp())",
      [input.tenantId, linkId, identityId, hash, proof.authDateUnixSeconds],
    );
    await client.query(
      "INSERT INTO cookie_customers.staging_customer_identities(tenant_id,customer_id,identity_id,telegram_link_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
      [input.tenantId, customerId, identityId, linkId],
    );
    discard = true;
    const committed = await client.query("COMMIT");
    if (committed.command !== "COMMIT")
      throw new Error("Staging customer provision not committed");
    discard = false;
    return { tenantId: input.tenantId, customerId };
  } catch (error) {
    if (!discard) {
      discard = true;
      try {
        const result = await client.query("ROLLBACK");
        if (result.command === "ROLLBACK") discard = false;
      } catch {
        /* discard */
      }
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

/** Read exact Customer relation under current policy and session locks. Never
 * accept a Customer identifier or identity from the client. The exact
 * link that minted this bearer must be the link in the synthetic binding.
 */
export async function readStagingCustomerContext(
  client: PoolClient,
  actor: TrustedActor,
): Promise<CustomerContext> {
  if (!actor.opaqueSessionAuthority) throw new AuthorizationDeniedError();
  await requireTenantPermission(
    client,
    actor,
    {
      kind: "customer-self",
      tenantId: actor.tenantId,
      clientIdentityId: actor.identityId,
    },
    CUSTOMER_CONTEXT_PERMISSION,
  );
  const result = await client.query<Binding>(
    "SELECT c.customer_id::text,c.identity_id::text,c.telegram_link_id::text FROM cookie_customers.staging_customer_identities c JOIN cookie_identity.opaque_sessions s ON s.tenant_id=c.tenant_id AND s.identity_id=c.identity_id AND s.telegram_link_id=c.telegram_link_id WHERE c.tenant_id=$1::uuid AND c.identity_id=$2::uuid AND s.token_sha256=decode($3::text,'hex') AND s.issuer=$4 AND s.audience=$5 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() FOR SHARE OF c",
    [
      actor.tenantId,
      actor.identityId,
      actor.opaqueSessionAuthority.tokenSha256,
      actor.opaqueSessionAuthority.issuer,
      actor.opaqueSessionAuthority.audience,
    ],
  );
  if (result.rowCount !== 1) throw new AuthorizationDeniedError();
  return { tenantId: actor.tenantId, customerId: result.rows[0]!.customer_id };
}
