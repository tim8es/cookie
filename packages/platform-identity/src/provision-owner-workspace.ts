import { createHash, randomUUID } from "node:crypto";

import type { Pool, QueryResultRow } from "pg";

/**
 * Server-side Organization provisioning for an ALREADY VERIFIED Identity.
 * Never pass an identityId taken from HTTP JSON, headers, a URL or a decoded
 * but unverified Telegram object. The operator CLI is privileged DB tooling,
 * not a customer authentication or account enrollment mechanism.
 */
export interface OwnerWorkspaceProvisionInput {
  readonly ownerIdentityId: string;
  readonly idempotencyKey: string;
  readonly organizationName: string;
  readonly locationName: string;
  readonly timeZone: string;
}

export interface OwnerWorkspaceProvisionResult {
  readonly tenantId: string;
  readonly locationId: string;
  readonly roleId: string;
  readonly assignmentId: string;
  readonly replayed: boolean;
}

export class OwnerWorkspaceProvisionError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "IDENTITY_NOT_FOUND"
      | "IDEMPOTENCY_KEY_REUSED",
  ) {
    super(code);
    this.name = "OwnerWorkspaceProvisionError";
  }
}

interface ReceiptRow extends QueryResultRow {
  readonly request_sha256: string;
  readonly tenant_id: string;
  readonly location_id: string;
  readonly role_id: string;
  readonly assignment_id: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;

const OWNER_PERMISSIONS = [
  "organization.context.read",
  "organization.transfer-owner",
  "booking.create",
  "booking.read",
  "booking.cancel",
  "booking.reschedule",
  "schedule.read",
  "catalog.service.read",
  "catalog.service.create",
  "catalog.service.edit-draft",
  "staff.profile.read",
  "staff.profile.create",
  "location.read",
  "location.create",
  "schedule.shift.plan.read",
  "schedule.shift.plan.create",
  "staging.entitlement.read",
  "staging.staff.publish",
  "appearance.read",
  "appearance.manage",
  "appearance.publish",
] as const;

function canonicalName(value: unknown): string {
  if (typeof value !== "string") {
    throw new OwnerWorkspaceProvisionError("INVALID_INPUT");
  }
  const normalized = value.normalize("NFC").trim();
  if (
    !normalized ||
    [...normalized].length > 200 ||
    /\p{Cc}/u.test(normalized)
  ) {
    throw new OwnerWorkspaceProvisionError("INVALID_INPUT");
  }
  return normalized;
}

function canonicalZone(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new OwnerWorkspaceProvisionError("INVALID_INPUT");
  }
  try {
    // PostgreSQL only checks syntax. Node's ICU validates an actual IANA zone.
    const canonical = new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
    if (!/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(canonical)) {
      throw new OwnerWorkspaceProvisionError("INVALID_INPUT");
    }
    return canonical;
  } catch {
    throw new OwnerWorkspaceProvisionError("INVALID_INPUT");
  }
}

/**
 * All six persisted records and the durable replay receipt commit atomically.
 * SELECT FOR UPDATE on the existing trusted Identity serializes concurrent
 * attempts sharing a key, without a global lock on unrelated organizations.
 * A new key intentionally permits a second Organization for the same Identity.
 */
export async function provisionOwnerWorkspace(
  pool: Pool,
  input: OwnerWorkspaceProvisionInput,
): Promise<OwnerWorkspaceProvisionResult> {
  if (
    !input ||
    typeof input.ownerIdentityId !== "string" ||
    !UUID.test(input.ownerIdentityId) ||
    typeof input.idempotencyKey !== "string" ||
    !KEY.test(input.idempotencyKey)
  ) {
    throw new OwnerWorkspaceProvisionError("INVALID_INPUT");
  }
  const organizationName = canonicalName(input.organizationName);
  const locationName = canonicalName(input.locationName);
  const timeZone = canonicalZone(input.timeZone);
  const sha256 = createHash("sha256")
    .update(JSON.stringify([1, organizationName, locationName, timeZone]))
    .digest("hex");

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    const identity = await client.query(
      "SELECT id FROM cookie_identity.identities WHERE id=$1::uuid FOR UPDATE",
      [input.ownerIdentityId],
    );
    if (identity.rowCount !== 1) {
      throw new OwnerWorkspaceProvisionError("IDENTITY_NOT_FOUND");
    }
    const existing = await client.query<ReceiptRow>(
      `SELECT request_sha256, tenant_id::text, location_id::text,
              role_id::text, assignment_id::text
         FROM cookie_tenancy.owner_setup_receipts
        WHERE owner_identity_id=$1::uuid AND idempotency_key=$2`,
      [input.ownerIdentityId, input.idempotencyKey],
    );
    const receipt = existing.rows[0];
    if (receipt) {
      if (receipt.request_sha256 !== sha256) {
        throw new OwnerWorkspaceProvisionError("IDEMPOTENCY_KEY_REUSED");
      }
      await client.query("COMMIT");
      inTransaction = false;
      return {
        tenantId: receipt.tenant_id,
        locationId: receipt.location_id,
        roleId: receipt.role_id,
        assignmentId: receipt.assignment_id,
        replayed: true,
      };
    }

    const tenantId = randomUUID();
    const locationId = randomUUID();
    const roleId = randomUUID();
    const assignmentId = randomUUID();

    await client.query(
      `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
       VALUES ($1::uuid,$2::uuid,$3)`,
      [tenantId, input.ownerIdentityId, organizationName],
    );
    await client.query(
      `INSERT INTO cookie_tenancy.locations(id,tenant_id,display_name,time_zone)
       VALUES ($1::uuid,$2::uuid,$3,$4)`,
      [locationId, tenantId, locationName, timeZone],
    );
    await client.query(
      `INSERT INTO cookie_identity.memberships(tenant_id,identity_id,active)
       VALUES ($1::uuid,$2::uuid,true)`,
      [tenantId, input.ownerIdentityId],
    );
    await client.query(
      `INSERT INTO cookie_identity.roles
         (tenant_id,id,base_type,display_name,permissions,active)
       VALUES ($1::uuid,$2::uuid,'owner','Owner',$3::text[],true)`,
      [tenantId, roleId, [...OWNER_PERMISSIONS]],
    );
    await client.query(
      `INSERT INTO cookie_identity.role_assignments
         (tenant_id,id,identity_id,role_id,location_id,active)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,NULL,true)`,
      [tenantId, assignmentId, input.ownerIdentityId, roleId],
    );
    await client.query(
      `INSERT INTO cookie_tenancy.owner_setup_receipts
         (owner_identity_id,idempotency_key,request_sha256,
          tenant_id,location_id,role_id,assignment_id)
       VALUES ($1::uuid,$2,$3,$4::uuid,$5::uuid,$6::uuid,$7::uuid)`,
      [
        input.ownerIdentityId,
        input.idempotencyKey,
        sha256,
        tenantId,
        locationId,
        roleId,
        assignmentId,
      ],
    );
    await client.query("COMMIT");
    inTransaction = false;
    return { tenantId, locationId, roleId, assignmentId, replayed: false };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
