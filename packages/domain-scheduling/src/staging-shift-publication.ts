import type { Pool, QueryResultRow } from "pg";
import { runSqlTransaction } from "../../platform-db/src/index.js";

import { lockLiveStagingGrant } from "../../domain-entitlement/src/index.js";
import type { TrustedActor } from "../../platform-identity/src/index.js";
import {
  PublishShiftFailure,
  publishShiftInternal,
  type PublishedShiftReceipt,
} from "./publish-shift.js";

/** Only for explicitly enabled synthetic staging. No Customer or Booking API. */
export async function publishStagingShift(
  pool: Pool,
  actor: TrustedActor,
  shiftId: string,
  expectedRevision: number,
  idempotencyKey: string,
): Promise<PublishedShiftReceipt> {
  return runSqlTransaction(pool, async (client) => {
    const receipt = await publishShiftInternal(
      pool,
      { actor, shiftId, idempotencyKey },
      async (transaction, context) => {
        // Called only after Staff -> Shift -> current owner policy locks.
        // The grant serializes revocation against a publication.
        await lockLiveStagingGrant(transaction, context.tenantId);
        const target = await transaction.query(
          `SELECT 1
             FROM cookie_staff.staff_profiles p
             JOIN cookie_staff.location_assignments l
               ON l.tenant_id=p.tenant_id AND l.staff_id=p.id
             JOIN cookie_staff.service_assignments a
               ON a.tenant_id=l.tenant_id AND a.staff_id=l.staff_id
              AND a.location_id=l.location_id
             JOIN cookie_catalog.services s
               ON s.tenant_id=a.tenant_id AND s.id=a.service_id
            WHERE p.tenant_id=$1::uuid AND p.id=$2::uuid
              AND l.location_id=$3::uuid AND p.active AND p.bookable
              AND l.active AND a.active AND s.active
            ORDER BY s.id LIMIT 1 FOR SHARE OF p,l,a,s`,
          [context.tenantId, context.staffId, context.locationId],
        );
        if (target.rowCount !== 1)
          throw new PublishShiftFailure("SHIFT_TARGET_UNAVAILABLE");
        await lockLiveStagingGrant(transaction, context.tenantId);
      },
      client,
      { expectedRevision },
    );
    // Recheck the database's time after all locks/business writes, including
    // exact replay. Revocation cannot pass the grant lock before COMMIT.
    await lockLiveStagingGrant(client, actor.tenantId);
    return receipt;
  });
}

interface PublishedRow extends QueryResultRow {
  id: string;
  staff_id: string;
  location_id: string;
  start_at: Date;
  end_at: Date;
}

/** Existing publication history stays visible after grant expiry. */
export async function listStagingPublishedShifts(
  client: import("pg").PoolClient,
  tenantId: string,
): Promise<{ published: PublishedShiftReceipt[]; hasMore: boolean }> {
  const result = await client.query<PublishedRow>(
    `SELECT id::text,staff_id::text,location_id::text,start_at,end_at
       FROM cookie_scheduling.shift_windows w
      WHERE tenant_id=$1::uuid AND active AND end_at>clock_timestamp()
        AND EXISTS (SELECT 1 FROM cookie_scheduling.shift_publish_audit a
          WHERE a.tenant_id=w.tenant_id AND a.shift_id=w.id)
      ORDER BY start_at,id LIMIT 201`,
    [tenantId],
  );
  return {
    published: result.rows.slice(0, 200).map((row) => ({
      shiftId: row.id,
      staffId: row.staff_id,
      locationId: row.location_id,
      startAt: row.start_at.toISOString(),
      endAt: row.end_at.toISOString(),
      active: true,
    })),
    hasMore: result.rows.length > 200,
  };
}
