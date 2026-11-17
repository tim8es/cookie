import type { PoolClient, QueryResultRow } from "pg";
import type { ShiftDraftReceipt } from "./draft-shift.js";

interface PlanRow extends QueryResultRow {
  readonly id: string;
  readonly staff_id: string;
  readonly location_id: string;
  readonly start_at: Date;
  readonly end_at: Date;
  readonly draft_revision: number;
}

/** Never list disabled historical shifts as editable drafts. */
export async function listOwnerShiftPlans(
  client: PoolClient,
  tenantId: string,
): Promise<{ plans: ShiftDraftReceipt[]; hasMore: boolean }> {
  const found = await client.query<PlanRow>(
    `SELECT shift.id::text,shift.staff_id::text,shift.location_id::text,
            shift.start_at,shift.end_at,shift.draft_revision
       FROM cookie_scheduling.shift_windows AS shift
      WHERE shift.tenant_id=$1::uuid AND NOT shift.active
        AND shift.start_at>clock_timestamp()
        AND EXISTS (
          SELECT 1 FROM cookie_scheduling.shift_draft_audit a
           WHERE a.tenant_id=shift.tenant_id AND a.shift_id=shift.id
             AND a.operation='create'
        )
        AND NOT EXISTS (
          SELECT 1 FROM cookie_scheduling.shift_publish_audit a
           WHERE a.tenant_id=shift.tenant_id AND a.shift_id=shift.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM cookie_scheduling.shift_disable_audit a
           WHERE a.tenant_id=shift.tenant_id AND a.shift_id=shift.id
        )
      ORDER BY shift.start_at,shift.id LIMIT 201`,
    [tenantId],
  );
  return {
    plans: found.rows.slice(0, 200).map((row) => ({
      shiftId: row.id,
      staffId: row.staff_id,
      locationId: row.location_id,
      startAt: row.start_at.toISOString(),
      endAt: row.end_at.toISOString(),
      active: false,
      revision: row.draft_revision,
    })),
    hasMore: found.rows.length > 200,
  };
}
