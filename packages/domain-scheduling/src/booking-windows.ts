import type { PoolClient } from "pg";

import type { UtcInterval } from "./index.js";

interface ScheduleWindowScope {
  readonly tenantId: string;
  readonly staffId: string;
  readonly locationId: string;
}
interface WindowRow {
  start_at: Date;
  end_at: Date;
}
interface BlockedRow extends WindowRow {
  kind: "break" | "exception";
}

export interface LockedBlockedWindow extends UtcInterval {
  readonly kind: "break" | "exception";
}

/**
 * Internal transaction-scoped Scheduling read capability for the Booking
 * consistency boundary. Caller owns authorization, the staff serialization
 * lock and transaction; these row locks must live through caller COMMIT.
 * No independent transaction, public access, slot hold or Booking lookup.
 */
export async function lockActiveShiftWindows(
  client: PoolClient,
  scope: ScheduleWindowScope,
): Promise<UtcInterval[]> {
  const result = await client.query<WindowRow>(
    `SELECT start_at, end_at FROM cookie_scheduling.shift_windows
        WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
          AND location_id=$3::uuid AND active
        FOR SHARE`,
    [scope.tenantId, scope.staffId, scope.locationId],
  );
  return result.rows.map((row) => ({
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
  }));
}

/** Same caller-owned locking contract, for active breaks and exceptions. */
export async function lockActiveBlockedWindows(
  client: PoolClient,
  scope: ScheduleWindowScope,
): Promise<LockedBlockedWindow[]> {
  const result = await client.query<BlockedRow>(
    `SELECT start_at, end_at, kind FROM cookie_scheduling.blocked_windows
        WHERE tenant_id=$1::uuid AND staff_id=$2::uuid
          AND location_id=$3::uuid AND active
        FOR SHARE`,
    [scope.tenantId, scope.staffId, scope.locationId],
  );
  return result.rows.map((row) => ({
    startAt: row.start_at.toISOString(),
    endAt: row.end_at.toISOString(),
    kind: row.kind,
  }));
}
