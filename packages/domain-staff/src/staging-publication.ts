import { createHash } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import {
  assertNewStagingSeat,
  lockLiveStagingGrant,
} from "../../domain-entitlement/src/staging.js";
import type { TrustedActor } from "../../platform-identity/src/authorization.js";
import { requireTenantPermission } from "../../platform-identity/src/postgres.js";

export interface StagingStaffPublicationInput {
  readonly staffId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly expectedServiceRevision: number;
}
export interface StagingStaffPublicationReceipt {
  readonly staffId: string;
  readonly locationId: string;
  readonly serviceId: string;
}
export class StagingStaffPublicationConflict extends Error {
  constructor(readonly code: "target-unavailable" | "already-bookable" | "stale-revision" | "idempotency-conflict") {
    super(code);
  }
}
interface ProfileRow extends QueryResultRow {
  active: boolean;
  bookable: boolean;
}
interface ServiceRow extends QueryResultRow {
  active: boolean;
  draft_revision: number;
}
interface ReceiptRow extends QueryResultRow {
  request_sha256: string;
  staff_id: string;
  location_id: string;
  service_id: string;
}

/**
 * Staff-first transaction order follows scheduling. After current owner/session
 * authorization, the grant row is held exclusive, serializing every new seat
 * across all locations. Service and exact assignment rows are then locked.
 * No shift is activated; no public routes, payments or commercial licenses.
 */
export async function publishStaffForStaging(
  pool: Pool,
  actor: TrustedActor,
  key: string,
  input: StagingStaffPublicationInput,
): Promise<{ publication: StagingStaffPublicationReceipt; replayed: boolean }> {
  const { staffId, locationId, serviceId, expectedServiceRevision } = input;
  const hash = createHash("sha256")
    .update(JSON.stringify([1, staffId, locationId, serviceId, expectedServiceRevision]))
    .digest("hex");
  const tenantId = actor.tenantId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const profile = await client.query<ProfileRow>(
      "SELECT active,bookable FROM cookie_staff.staff_profiles WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE",
      [tenantId, staffId],
    );
    await requireTenantPermission(client, actor, { kind: "organization", tenantId }, "staging.staff.publish");
    if (!profile.rows[0]?.active) throw new StagingStaffPublicationConflict("target-unavailable");
    const grant = await lockLiveStagingGrant(client, tenantId);
    const prior = await client.query<ReceiptRow>(
      "SELECT request_sha256,staff_id::text,location_id::text,service_id::text FROM cookie_staff.staging_publication_receipts WHERE tenant_id=$1::uuid AND actor_identity_id=$2::uuid AND idempotency_key=$3",
      [tenantId, actor.identityId, key],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].request_sha256 !== hash)
        throw new StagingStaffPublicationConflict("idempotency-conflict");
      await client.query("COMMIT");
      return { publication: { staffId, locationId, serviceId }, replayed: true };
    }
    if (profile.rows[0].bookable)
      throw new StagingStaffPublicationConflict("already-bookable");
    await assertNewStagingSeat(client, tenantId, grant.seatLimit);
    const service = await client.query<ServiceRow>(
      "SELECT active,draft_revision FROM cookie_catalog.services WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE",
      [tenantId, serviceId],
    );
    if (!service.rows[0]) throw new StagingStaffPublicationConflict("target-unavailable");
    if (service.rows[0].draft_revision !== expectedServiceRevision)
      throw new StagingStaffPublicationConflict("stale-revision");
    const branch = await client.query(
      "SELECT id FROM cookie_tenancy.locations WHERE tenant_id=$1::uuid AND id=$2::uuid AND time_zone IS NOT NULL FOR SHARE",
      [tenantId, locationId],
    );
    const assignment = await client.query(
      "SELECT active FROM cookie_staff.location_assignments WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid FOR UPDATE",
      [tenantId, staffId, locationId],
    );
    const serviceAssignment = await client.query(
      "SELECT active FROM cookie_staff.service_assignments WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid AND service_id=$4::uuid FOR UPDATE",
      [tenantId, staffId, locationId, serviceId],
    );
    if (branch.rowCount !== 1 || assignment.rowCount !== 1 || serviceAssignment.rowCount !== 1)
      throw new StagingStaffPublicationConflict("target-unavailable");
    // Explicitly selected service only. Shared active services are reused.
    if (!service.rows[0].active) {
      await client.query(
        "UPDATE cookie_catalog.services SET active=true,draft_revision=draft_revision+1 WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenantId, serviceId],
      );
    }
    await client.query(
      "UPDATE cookie_staff.location_assignments SET active=true WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid",
      [tenantId, staffId, locationId],
    );
    await client.query(
      "UPDATE cookie_staff.service_assignments SET active=true WHERE tenant_id=$1::uuid AND staff_id=$2::uuid AND location_id=$3::uuid AND service_id=$4::uuid",
      [tenantId, staffId, locationId, serviceId],
    );
    await client.query(
      "UPDATE cookie_staff.staff_profiles SET bookable=true WHERE tenant_id=$1::uuid AND id=$2::uuid",
      [tenantId, staffId],
    );
    await client.query(
      "INSERT INTO cookie_staff.staging_publication_receipts(tenant_id,actor_identity_id,idempotency_key,request_sha256,staff_id,location_id,service_id,grant_id) VALUES($1::uuid,$2::uuid,$3,$4,$5::uuid,$6::uuid,$7::uuid,$8::uuid)",
      [tenantId, actor.identityId, key, hash, staffId, locationId, serviceId, grant.id],
    );
    // Recheck database time just before commit, including time spent waiting
    // on service/assignment locks. Revocation cannot pass the grant lock.
    await lockLiveStagingGrant(client, tenantId);
    await client.query("COMMIT");
    return { publication: { staffId, locationId, serviceId }, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
