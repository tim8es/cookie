import assert from "node:assert/strict";
import test from "node:test";

import type { PoolClient } from "pg";

import {
  lockActiveBlockedWindows,
  lockActiveShiftWindows,
} from "../../../packages/domain-scheduling/src/index.js";

test("Scheduling window capabilities use only the supplied client and scope", async () => {
  const statements: string[] = [];
  const values: unknown[] = [];
  const scope = {
    tenantId: "tenant",
    staffId: "staff",
    locationId: "location",
  };
  const client = {
    async query(sql: string, params: unknown[]) {
      statements.push(sql);
      values.push(params);
      const row = {
        start_at: new Date("2027-05-01T10:00:00Z"),
        end_at: new Date("2027-05-01T11:00:00Z"),
      };
      return {
        rows: [
          sql.includes("blocked_windows") ? { ...row, kind: "break" } : row,
        ],
      };
    },
  } as unknown as PoolClient;
  const [shifts, blocked] = await Promise.all([
    lockActiveShiftWindows(client, scope),
    lockActiveBlockedWindows(client, scope),
  ]);
  const interval = {
    startAt: "2027-05-01T10:00:00.000Z",
    endAt: "2027-05-01T11:00:00.000Z",
  };
  assert.deepEqual(shifts, [interval]);
  assert.deepEqual(blocked, [{ ...interval, kind: "break" }]);
  assert.equal(statements.length, 2);
  assert.match(statements[0]!, /FROM cookie_scheduling\.shift_windows/);
  assert.match(statements[1]!, /FROM cookie_scheduling\.blocked_windows/);
  for (const sql of statements) {
    assert.match(sql, /tenant_id=\$1::uuid AND staff_id=\$2::uuid/);
    assert.match(sql, /location_id=\$3::uuid AND active/);
    assert.match(sql, /FOR SHARE$/);
  }
  assert.deepEqual(values, [
    ["tenant", "staff", "location"],
    ["tenant", "staff", "location"],
  ]);
});
