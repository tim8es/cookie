import { randomUUID } from "node:crypto";
import { runSqlTransaction } from "../../platform-db/src/index.js";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { TelegramMiniAppProofVerifier } from "../../platform-identity/src/index.js";
import { lockTelegramUser } from "../../platform-identity/src/index.js";
import {
  AuthorizationDeniedError,
  appendAuthIdentityAudit,
  type TrustedActor,
} from "../../platform-identity/src/index.js";
import { requireTenantPermission } from "../../platform-identity/src/index.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CUSTOMER_CONTEXT_PERMISSION = "staging.customer.context.read";
export const CUSTOMER_OFFERS_PERMISSION = "staging.customer.offers.read";
const CUSTOMER_BOOKING_PERMISSION = "staging.customer.booking.create";
const CUSTOMER_HISTORY_PERMISSION = "staging.customer.bookings.read";
const CUSTOMER_CANCEL_PERMISSION = "staging.customer.booking.cancel";

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
  telegram_link_id: string | null;
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
  return runSqlTransaction(pool, async (client) => {
    // Same organization then fingerprint lock order as owner link.
    const org = await client.query(
      "SELECT id FROM cookie_tenancy.organizations WHERE id=$1::uuid FOR UPDATE",
      [input.tenantId],
    );
    if (org.rowCount !== 1)
      throw new Error("Staging customer tenant unavailable");
    const hash = await lockTelegramUser(client, secret, proof.telegramUserId);
    const globalIdentity = await client.query(
      "SELECT 1 FROM cookie_identity.global_telegram_identities WHERE telegram_user_hmac_sha256=$1::bytea FOR SHARE",
      [hash],
    );
    if (globalIdentity.rowCount)
      throw new Error("Staging customer link conflict");
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
      "INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions) VALUES($1::uuid,$2::uuid,'client','Staging Client',ARRAY[$3::text,$4::text,$5::text,$6::text,$7::text])",
      [
        input.tenantId,
        roleId,
        CUSTOMER_CONTEXT_PERMISSION,
        CUSTOMER_OFFERS_PERMISSION,
        CUSTOMER_BOOKING_PERMISSION,
        CUSTOMER_HISTORY_PERMISSION,
        CUSTOMER_CANCEL_PERMISSION,
      ],
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
    return { tenantId: input.tenantId, customerId };
  });
}

/** Enroll an authenticated Identity as a client after explicit consent. */
export async function enrollStagingCustomerInTransaction(
  client: PoolClient,
  tenantId: string,
  identityId: string,
  consentConfirmed: unknown,
): Promise<CustomerContext> {
  if (
    !UUID.test(tenantId) ||
    !UUID.test(identityId) ||
    consentConfirmed !== true
  )
    throw new AuthorizationDeniedError();

  const identity = await client.query(
    "SELECT id FROM cookie_identity.identities WHERE id=$1::uuid FOR UPDATE",
    [identityId],
  );
  if (identity.rowCount !== 1) throw new AuthorizationDeniedError();

  const membership = await client.query<{ active: boolean }>(
    "SELECT active FROM cookie_identity.memberships WHERE tenant_id=$1::uuid AND identity_id=$2::uuid FOR UPDATE",
    [tenantId, identityId],
  );
  if (membership.rows[0]?.active === false)
    throw new AuthorizationDeniedError();
  if (membership.rowCount === 0) {
    await client.query(
      "INSERT INTO cookie_identity.memberships(tenant_id,identity_id,active) VALUES($1::uuid,$2::uuid,true)",
      [tenantId, identityId],
    );
  }

  const existing = await client.query<{ customer_id: string }>(
    "SELECT customer_id::text FROM cookie_customers.staging_customer_identities WHERE tenant_id=$1::uuid AND identity_id=$2::uuid FOR UPDATE",
    [tenantId, identityId],
  );
  const customerId = existing.rows[0]?.customer_id;
  if (customerId) return { tenantId, customerId };

  const customer = randomUUID();
  const roleId = randomUUID();
  await client.query(
    "INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions) VALUES($1::uuid,$2::uuid,'client','Client',ARRAY[$3::text,$4::text,$5::text,$6::text,$7::text])",
    [
      tenantId,
      roleId,
      CUSTOMER_CONTEXT_PERMISSION,
      CUSTOMER_OFFERS_PERMISSION,
      CUSTOMER_BOOKING_PERMISSION,
      CUSTOMER_HISTORY_PERMISSION,
      CUSTOMER_CANCEL_PERMISSION,
    ],
  );
  await client.query(
    "INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid)",
    [tenantId, randomUUID(), identityId, roleId],
  );
  await client.query(
    "INSERT INTO cookie_customers.customers(tenant_id,id) VALUES($1::uuid,$2::uuid)",
    [tenantId, customer],
  );
  await client.query(
    `INSERT INTO cookie_customers.staging_customer_identities
       (tenant_id,customer_id,identity_id,telegram_link_id,consent_confirmed_at)
     VALUES($1::uuid,$2::uuid,$3::uuid,NULL,clock_timestamp())`,
    [tenantId, customer, identityId],
  );
  await appendAuthIdentityAudit(client, "customer_enrolled", identityId);
  return { tenantId, customerId: customer };
}

/** Read exact Customer relation under current policy and session locks. Never
 * accept a Customer identifier or identity from the client. Legacy tenant
 * sessions must match their original Telegram link; global Identity sessions
 * resolve the same Customer relation through the locked Identity session.
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
  const result =
    actor.opaqueSessionAuthority.kind === "identity"
      ? await client.query<Binding>(
          `SELECT c.customer_id::text,c.identity_id::text,c.telegram_link_id::text
           FROM cookie_customers.staging_customer_identities c
           JOIN cookie_identity.identity_sessions s
             ON s.identity_id=c.identity_id
            AND s.token_sha256=decode($3::text,'hex')
            AND s.issuer=$4 AND s.audience=$5
            AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
           WHERE c.tenant_id=$1::uuid AND c.identity_id=$2::uuid
           FOR SHARE OF c`,
          [
            actor.tenantId,
            actor.identityId,
            actor.opaqueSessionAuthority.tokenSha256,
            actor.opaqueSessionAuthority.issuer,
            actor.opaqueSessionAuthority.audience,
          ],
        )
      : await client.query<Binding>(
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
