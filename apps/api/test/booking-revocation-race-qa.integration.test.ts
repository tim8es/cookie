import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import { cancelBookingInternal } from "../../../packages/domain-booking/src/cancel.js";
import { createBookingInternal } from "../../../packages/domain-booking/src/create.js";
import { rescheduleBookingInternal } from "../../../packages/domain-booking/src/reschedule.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

type Result =
  | { readonly kind: "fulfilled"; readonly value: unknown }
  | { readonly kind: "rejected"; readonly code: string };
type PermissionTable = "memberships" | "roles" | "role_assignments";
interface RaceResult {
  readonly operation: string;
  readonly revokeCommittedFirst: boolean;
  readonly revokeSerialized: boolean;
  readonly result: Result;
}
interface BusinessState {
  readonly bookings: string;
  readonly confirmed: string;
  readonly cancelled: string;
  readonly receipts: string;
  readonly events: string;
  readonly moveAudits: string;
  readonly cancelAudits: string;
}

async function snapshot(pool: Pool, tenant: string): Promise<BusinessState> {
  const result = await pool.query<BusinessState>(
    `SELECT
       (SELECT count(*)::text FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid) AS bookings,
       (SELECT count(*)::text FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed,
       (SELECT count(*)::text FROM cookie_booking.bookings
        WHERE tenant_id=$1::uuid AND status='CancelledByBusiness') AS cancelled,
       (SELECT count(*)::text FROM cookie_booking.command_receipts
        WHERE tenant_id=$1::uuid) AS receipts,
       (SELECT count(*)::text FROM cookie_jobs.outbox_events
        WHERE tenant_id=$1::uuid) AS events,
       (SELECT count(*)::text FROM cookie_booking.time_change_audit
        WHERE tenant_id=$1::uuid) AS "moveAudits",
       (SELECT count(*)::text FROM cookie_booking.booking_state_audit
        WHERE tenant_id=$1::uuid) AS "cancelAudits"`,
    [tenant],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}

/**
 * Force a deterministic ordering at a known checkpoint AFTER the command
 * checks AuthZ but BEFORE it writes its business mutation.
 *
 * A safe implementation may choose either strategy:
 * 1. Revocation commits first: command must recheck the current permission
 *    and deny before durable side effects.
 * 2. Policy rows are locked until command COMMIT: revocation times out on its
 *    short test transaction, and the command commits BEFORE a later revoke.
 *
 * A mutation that succeeds after a revocation ALREADY committed is unsafe.
 * Only synthetic PostgreSQL fixtures and trusted policy callbacks are used.
 */
async function raceRevocation(
  pool: Pool,
  input: {
    readonly label: string;
    readonly table: PermissionTable;
    readonly tenant: string;
    readonly rowId: string;
    /** Also exercise revocation by editing the granted permission, not just active flags. */
    readonly revokeKind?: "deactivate" | "clear-role-permissions";
    readonly submit: (hold: () => Promise<void>) => Promise<unknown>;
  },
): Promise<RaceResult> {
  let signalCheckpoint!: () => void;
  let releaseCheckpoint!: () => void;
  const checkpoint = new Promise<void>((resolve) => {
    signalCheckpoint = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    releaseCheckpoint = resolve;
  });
  const completion: Promise<Result> = input
    .submit(async () => {
      signalCheckpoint();
      await resume;
    })
    .then(
      (value): Result => ({ kind: "fulfilled", value }),
      (error: unknown): Result => ({
        kind: "rejected",
        code: (error as { code?: string }).code ?? "UNKNOWN",
      }),
    );
  const wasReached = await Promise.race([
    checkpoint.then(() => true),
    completion.then(() => false),
  ]);
  assert.equal(wasReached, true, "domain policy checkpoint must be reached");

  assert.ok(
    input.revokeKind !== "clear-role-permissions" || input.table === "roles",
    "Only roles can have permissions removed",
  );
  const column = input.table === "memberships" ? "identity_id" : "id";
  const revokeSql =
    "UPDATE cookie_identity." +
    input.table +
    (input.revokeKind === "clear-role-permissions"
      ? " SET permissions=ARRAY[]::text[]"
      : " SET active=false") +
    " WHERE tenant_id=$1::uuid AND " +
    column +
    "=$2::uuid";

  const revoker = await pool.connect();
  let revokeCommittedFirst = false;
  let revokeSerialized = false;
  try {
    await revoker.query("BEGIN");
    await revoker.query("SET LOCAL lock_timeout='500ms'");
    await revoker.query(revokeSql, [input.tenant, input.rowId]);
    await revoker.query("COMMIT");
    revokeCommittedFirst = true;
  } catch (error) {
    await revoker.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code !== "55P03") throw error;
    revokeSerialized = true;
  } finally {
    revoker.release();
    releaseCheckpoint();
  }

  const result = await completion;

  if (revokeSerialized) {
    // The command was allowed to finish before revocation. This is a safe
    // serialization outcome, not evidence of a revocation bypass.
    await pool.query(revokeSql, [input.tenant, input.rowId]);
  }

  return {
    operation: input.label,
    revokeCommittedFirst,
    revokeSerialized,
    result,
  };
}

test(
  "revocation that commits before booking mutation must deny Create, Reschedule and Cancel",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-revocation-race",
      max: 6,
      connectionTimeoutMillis: 5_000,
    });
    const tenant = randomUUID();
    const owner = randomUUID();
    const role = randomUUID();
    const assignment = randomUUID();
    const location = randomUUID();
    const staff = randomUUID();
    const service = randomUUID();
    const customer = randomUUID();
    const actor = {
      tenantId: tenant,
      identityId: owner,
      correlationId: "synthetic-qa-live-revocation-race",
    };
    const allow = async (): Promise<void> => undefined;
    const base = {
      actor,
      customerId: customer,
      locationId: location,
      staffId: staff,
      serviceId: service,
    };
    const races: RaceResult[] = [];

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations
           (id,owner_identity_id,display_name)
         VALUES ($1::uuid,$2::uuid,'Synthetic revocation race QA')`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES ($1::uuid,$2::uuid,'QA branch','UTC')`,
        [tenant, location],
      );
      await pool.query(
        `INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
         VALUES ($1::uuid,$2::uuid)`,
        [tenant, owner],
      );
      await pool.query(
        `INSERT INTO cookie_identity.roles
           (tenant_id,id,base_type,display_name,permissions)
         VALUES ($1::uuid,$2::uuid,'owner','Synthetic owner',
                 ARRAY['booking.create','booking.reschedule','booking.cancel'])`,
        [tenant, role],
      );
      await pool.query(
        `INSERT INTO cookie_identity.role_assignments
           (tenant_id,id,identity_id,role_id)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
        [tenant, assignment, owner, role],
      );
      await pool.query(
        `INSERT INTO cookie_customers.customers(tenant_id,id)
         VALUES ($1::uuid,$2::uuid)`,
        [tenant, customer],
      );
      await pool.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,
            post_service_buffer_minutes,base_price_kopecks,active)
         VALUES ($1::uuid,$2::uuid,'QA service',60,10,135000,true)`,
        [tenant, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles
           (tenant_id,id,display_name,active,bookable)
         VALUES ($1::uuid,$2::uuid,'QA staff',true,true)`,
        [tenant, staff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,true)`,
        [tenant, staff, location],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,true)`,
        [tenant, staff, location, service],
      );
      await pool.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,
                 '2028-12-14T09:00:00Z','2028-12-14T19:00:00Z',true)`,
        [tenant, randomUUID(), staff, location],
      );

      // An unrelated valid booking provides a Confirmed target for both
      // Reschedule and Cancel regardless of the first race's outcome.
      const seed = await createBookingInternal(
        pool,
        {
          ...base,
          startAt: "2028-12-14T10:00:00Z",
          idempotencyKey: "synthetic-seed-not-the-race",
        },
        allow,
      );
      assert.equal(seed.status, "Confirmed");

      races.push(
        await raceRevocation(pool, {
          label: "booking.create / membership",
          table: "memberships",
          tenant,
          rowId: owner,
          submit: (hold) =>
            createBookingInternal(
              pool,
              {
                ...base,
                startAt: "2028-12-14T14:00:00Z",
                idempotencyKey: "race-create-after-policy-read",
              },
              hold,
            ),
        }),
      );
      await pool.query(
        `UPDATE cookie_identity.memberships SET active=true
         WHERE tenant_id=$1::uuid AND identity_id=$2::uuid`,
        [tenant, owner],
      );

      races.push(
        await raceRevocation(pool, {
          label: "booking.reschedule / role",
          table: "roles",
          tenant,
          rowId: role,
          submit: (hold) =>
            rescheduleBookingInternal(
              pool,
              {
                actor,
                bookingId: seed.bookingId,
                newStartAt: "2028-12-14T11:30:00Z",
                idempotencyKey: "race-move-after-policy-read",
              },
              hold,
            ),
        }),
      );
      await pool.query(
        `UPDATE cookie_identity.roles SET active=true
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, role],
      );

      races.push(
        await raceRevocation(pool, {
          label: "booking.cancel / role assignment",
          table: "role_assignments",
          tenant,
          rowId: assignment,
          submit: (hold) =>
            cancelBookingInternal(
              pool,
              {
                actor,
                bookingId: seed.bookingId,
                idempotencyKey: "race-cancel-after-policy-read",
              },
              hold,
            ),
        }),
      );

      // Role permission grants can be revoked without toggling active.
      // This must obey the same authorization/COMMIT ordering as a disable.
      await pool.query(
        `UPDATE cookie_identity.role_assignments SET active=true
         WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenant, assignment],
      );
      races.push(
        await raceRevocation(pool, {
          label: "booking.create / role permissions removed",
          table: "roles",
          revokeKind: "clear-role-permissions",
          tenant,
          rowId: role,
          submit: (hold) =>
            createBookingInternal(
              pool,
              {
                ...base,
                startAt: "2028-12-14T16:00:00Z",
                idempotencyKey: "race-create-permission-removal",
              },
              hold,
            ),
        }),
      );

      const after = await snapshot(pool, tenant);
      const violations = races
        .filter(
          (race) =>
            race.revokeCommittedFirst && race.result.kind === "fulfilled",
        )
        .map((race) => race.operation);
      assert.deepEqual(
        violations,
        [],
        "Security failure: a booking mutation committed AFTER the relevant " +
          "permission revocation had already committed. " +
          JSON.stringify({ races, after }),
      );

      // Both orders are valid: a blocking authorization lock may serialize
      // the operation before revoke; otherwise the revoke wins and the
      // later business command must explicitly be denied.
      for (const race of races) {
        if (race.revokeCommittedFirst) {
          assert.deepEqual(race.result, {
            kind: "rejected",
            code: "ACCESS_DENIED",
          });
        } else {
          assert.equal(race.revokeSerialized, true);
        }
      }
    } finally {
      const tables = [
        "cookie_booking.time_change_audit",
        "cookie_booking.booking_state_audit",
        "cookie_booking.command_receipts",
        "cookie_jobs.outbox_replay_audit",
        "cookie_jobs.outbox_events",
        "cookie_booking.bookings",
        "cookie_identity.authorization_audit",
        "cookie_scheduling.blocked_windows",
        "cookie_scheduling.shift_windows",
        "cookie_staff.service_assignments",
        "cookie_staff.location_assignments",
        "cookie_staff.staff_profiles",
        "cookie_catalog.services",
        "cookie_customers.customers",
        "cookie_identity.role_assignments",
        "cookie_identity.roles",
        "cookie_identity.memberships",
        "cookie_tenancy.locations",
      ];
      try {
        for (const table of tables) {
          await pool
            .query("DELETE FROM " + table + " WHERE tenant_id=$1::uuid", [
              tenant,
            ])
            .catch(() => undefined);
        }
        await pool
          .query("DELETE FROM cookie_tenancy.organizations WHERE id=$1::uuid", [
            tenant,
          ])
          .catch(() => undefined);
        await pool
          .query("DELETE FROM cookie_identity.identities WHERE id=$1::uuid", [
            owner,
          ])
          .catch(() => undefined);
      } finally {
        await pool.end();
      }
    }
  },
);
