import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

export interface StagingCapacity {
  readonly state: "disabled" | "unconfigured" | "active" | "expired" | "revoked";
  readonly seatLimit: number | null;
  readonly usedSeats: number;
  readonly expiresAt: string | null;
}
interface GrantRow extends QueryResultRow {
  id: string;
  seat_limit: number;
  expires_at: Date;
  revoked_at: Date | null;
  live: boolean;
}
export class StagingPublicationDenied extends Error {
  constructor(readonly code: "grant-unavailable" | "seat-limit") {
    super(code);
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** No trial/paid status or price is invented. The operator supplies the limit. */
export function parseStagingPublicationMode(raw: string | undefined): boolean {
  if (raw === undefined || raw === "disabled") return false;
  if (raw === "enabled") return true;
  throw new Error("Invalid staging publication mode");
}

async function grantRow(client: PoolClient, tenantId: string, lock: boolean): Promise<GrantRow | undefined> {
  const result = await client.query<GrantRow>(
    "SELECT id::text,seat_limit,expires_at,revoked_at,expires_at>clock_timestamp() AS live FROM cookie_entitlement.staging_publication_grants WHERE tenant_id=$1::uuid" +
      (lock ? " FOR UPDATE" : ""),
    [tenantId],
  );
  return result.rows[0];
}

async function countSeats(client: PoolClient, tenantId: string): Promise<number> {
  // Count each unique active bookable profile once, regardless of shifts or
  // assignments. A missing assignment must not free a previously used seat.
  const result = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM cookie_staff.staff_profiles WHERE tenant_id=$1::uuid AND active AND bookable",
    [tenantId],
  );
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid seat count");
  return count;
}

export async function readStagingCapacity(
  client: PoolClient,
  tenantId: string,
  enabled: boolean,
): Promise<StagingCapacity> {
  // A single SQL snapshot avoids returning a new seat count with an older grant.
  const result = await client.query<GrantRow & { count: string }>(
    "SELECT g.id::text,g.seat_limit,g.expires_at,g.revoked_at,g.expires_at>clock_timestamp() AS live," +
      " (SELECT count(*)::text FROM cookie_staff.staff_profiles WHERE tenant_id=$1::uuid AND active AND bookable) AS count" +
      " FROM (SELECT $1::uuid AS tenant_id) t LEFT JOIN cookie_entitlement.staging_publication_grants g ON g.tenant_id=t.tenant_id",
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Missing capacity result");
  const usedSeats = Number(row.count);
  if (!Number.isSafeInteger(usedSeats) || usedSeats < 0) throw new Error("Invalid seat count");
  if (!enabled) return { state: "disabled", seatLimit: null, usedSeats, expiresAt: null };
  if (!row.id) return { state: "unconfigured", seatLimit: null, usedSeats, expiresAt: null };
  return {
    state: row.revoked_at ? "revoked" : row.live ? "active" : "expired",
    seatLimit: row.seat_limit,
    usedSeats,
    expiresAt: row.expires_at.toISOString(),
  };
}

/** Lock the unique grant row for every capacity-changing command, and keep it
 * through COMMIT. The caller must take the Staff and policy locks first.
 * This serializes different StaffProfile activations and grant revocation.
 */
export async function lockLiveStagingGrant(
  client: PoolClient,
  tenantId: string,
): Promise<{ id: string; seatLimit: number }> {
  const row = await grantRow(client, tenantId, true);
  if (!row || row.revoked_at || !row.live)
    throw new StagingPublicationDenied("grant-unavailable");
  return { id: row.id, seatLimit: row.seat_limit };
}

export async function assertNewStagingSeat(
  client: PoolClient,
  tenantId: string,
  seatLimit: number,
): Promise<void> {
  if ((await countSeats(client, tenantId)) >= seatLimit)
    throw new StagingPublicationDenied("seat-limit");
}

/** Privileged DB operator only, never called from an HTTP endpoint.
 * Explicit expiresAt and capacity; no renewal, reset, trial or payment.
 * Repeating the identical input is safe; revoked grants cannot be reinstated.
 */
export async function issueStagingGrant(
  pool: Pool,
  tenantId: string,
  seatLimit: number,
  expiresAt: string,
): Promise<string> {
  if (!UUID.test(tenantId) || !Number.isSafeInteger(seatLimit) ||
      seatLimit < 1 || seatLimit > 2147483647 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) ||
      !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt)
    throw new Error("Invalid staging grant");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await grantRow(client, tenantId, true);
    if (existing) {
      if (existing.revoked_at || !existing.live || existing.seat_limit !== seatLimit ||
          existing.expires_at.toISOString() !== expiresAt)
        throw new Error("Existing staging grant cannot be replaced");
      await client.query("COMMIT");
      return existing.id;
    }
    const id = randomUUID();
    await client.query(
      "INSERT INTO cookie_entitlement.staging_publication_grants(tenant_id,id,seat_limit,expires_at) VALUES($1::uuid,$2::uuid,$3,$4::timestamptz)",
      [tenantId,id,seatLimit,expiresAt],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function revokeStagingGrant(pool: Pool, tenantId: string): Promise<void> {
  if (!UUID.test(tenantId)) throw new Error("Invalid staging tenant");
  await pool.query(
    "UPDATE cookie_entitlement.staging_publication_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE tenant_id=$1::uuid",
    [tenantId],
  );
}
