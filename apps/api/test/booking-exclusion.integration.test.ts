import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

interface BookingInput {
  readonly tenantId: string;
  readonly id: string;
  readonly customerId: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly occupiedUntil: string;
  readonly priceKopecks?: number;
}

async function insertConfirmed(client: Pool | PoolClient, b: BookingInput): Promise<void> {
  await client.query(
    `INSERT INTO cookie_booking.bookings
       (tenant_id,id,customer_id,staff_id,location_id,service_id,status,
        start_at,end_at,occupied_until,
        service_duration_minutes_snapshot,post_service_buffer_minutes_snapshot,
        price_kopecks_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,'Confirmed',$7,$8,$9,60,10,$10)`,
    [
      b.tenantId, b.id, b.customerId, b.staffId, b.locationId, b.serviceId,
      b.startAt, b.endAt, b.occupiedUntil, b.priceKopecks ?? 150000,
    ],
  );
}

test(
  "PostgreSQL prevents concurrent Confirmed overlap across locations of one staff/tenant",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-booking-exclusion-integration",
      max: 4,
    });
    const owner = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const locationA1 = randomUUID();
    const locationA2 = randomUUID();
    const locationB = randomUUID();
    const staff = randomUUID();
    const service = randomUUID();
    const customerA = randomUUID();
    const customerB = randomUUID();
    const firstId = randomUUID();
    let first: PoolClient | undefined;
    let second: PoolClient | undefined;

    const base: BookingInput = {
      tenantId: tenantA,
      id: firstId,
      customerId: customerA,
      staffId: staff,
      locationId: locationA1,
      serviceId: service,
      startAt: "2026-11-15T10:00:00Z",
      endAt: "2026-11-15T11:00:00Z",
      occupiedUntil: "2026-11-15T11:10:00Z",
    };

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query("INSERT INTO cookie_identity.identities (id) VALUES ($1)", [owner]);
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations (id,owner_identity_id,display_name)
         VALUES ($1,$3,'Synthetic booking A'),($2,$3,'Synthetic booking B')`,
        [tenantA, tenantB, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations (tenant_id,id,display_name,time_zone)
         VALUES ($1,$2,'A1','UTC'),($1,$3,'A2','UTC'),($4,$5,'B','UTC')`,
        [tenantA, locationA1, locationA2, tenantB, locationB],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles (tenant_id,id,display_name)
         VALUES ($1,$3,'Synthetic master A'),($2,$3,'Synthetic master B')`,
        [tenantA, tenantB, staff],
      );
      await pool.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,post_service_buffer_minutes,base_price_kopecks)
         VALUES ($1,$3,'Service A',60,10,150000),($2,$3,'Service B',60,10,150000)`,
        [tenantA, tenantB, service],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments
          (tenant_id,staff_id,location_id,active)
         VALUES ($1,$3,$4,true),($1,$3,$5,true),($2,$3,$6,true)`,
        [tenantA, tenantB, staff, locationA1, locationA2, locationB],
      );
      await pool.query(
        `INSERT INTO cookie_staff.service_assignments
          (tenant_id,staff_id,location_id,service_id,active)
         VALUES ($1,$3,$4,$7,true),($1,$3,$5,$7,true),($2,$3,$6,$7,true)`,
        [tenantA, tenantB, staff, locationA1, locationA2, locationB, service],
      );
      await pool.query(
        `INSERT INTO cookie_customers.customers (tenant_id,id)
         VALUES($1,$3),($2,$4)`,
        [tenantA, tenantB, customerA, customerB],
      );

      first = await pool.connect();
      second = await pool.connect();
      await first.query("BEGIN");
      await second.query("BEGIN");
      await insertConfirmed(first, base);

      // Start another transaction BEFORE committing the first. The exclusion
      // constraint waits for the first transaction's result, then rejects it.
      const competing = {
        ...base,
        id: randomUUID(),
        locationId: locationA2,
        startAt: "2026-11-15T11:00:00Z",
        endAt: "2026-11-15T12:00:00Z",
        occupiedUntil: "2026-11-15T12:10:00Z",
      };
      const competingOutcome = insertConfirmed(second, competing).then(
        () => null,
        (error: unknown) => error,
      );
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30));
      await first.query("COMMIT");
      assert.deepEqual(
        (await competingOutcome as { code?: string } | null)?.code,
        "23P01",
        "a second location must not take a staff's post-service buffer",
      );
      await second.query("ROLLBACK");

      // [start, occupiedUntil) means 11:10 is available, not 11:05.
      const adjacent = {
        ...competing,
        id: randomUUID(),
        startAt: "2026-11-15T11:10:00Z",
        endAt: "2026-11-15T12:10:00Z",
        occupiedUntil: "2026-11-15T12:20:00Z",
      };
      await insertConfirmed(pool, adjacent);
      await assert.rejects(
        insertConfirmed(pool, {
          ...adjacent,
          id: randomUUID(),
          startAt: "2026-11-15T11:05:00Z",
          endAt: "2026-11-15T12:05:00Z",
          occupiedUntil: "2026-11-15T12:15:00Z",
        }),
        { code: "23P01" },
      );

      // A tenant with the same StaffProfile UUID must be independent.
      await insertConfirmed(pool, {
        ...base,
        tenantId: tenantB,
        customerId: customerB,
        locationId: locationB,
        id: randomUUID(),
      });

      // Every relationship must remain tenant-consistent.
      await assert.rejects(
        insertConfirmed(pool, {
          ...base,
          id: randomUUID(),
          customerId: customerB,
          startAt: "2026-11-15T14:00:00Z",
          endAt: "2026-11-15T15:00:00Z",
          occupiedUntil: "2026-11-15T15:10:00Z",
        }),
        { code: "23503" },
      );

      // The client-visible end must not silently include/postpone a buffer.
      await assert.rejects(
        insertConfirmed(pool, {
          ...base,
          id: randomUUID(),
          startAt: "2026-11-15T15:00:00Z",
          endAt: "2026-11-15T16:00:00Z",
          occupiedUntil: "2026-11-15T16:15:00Z",
        }),
        { code: "23514" },
      );
      await assert.rejects(
        pool.query(
          `UPDATE cookie_booking.bookings SET status='CancelledByClient'
           WHERE tenant_id=$1 AND id=$2`,
          [tenantA, firstId],
        ),
        { code: "23514" },
        "cancellation cannot silently omit a cancellation timestamp",
      );

      await pool.query(
        `UPDATE cookie_booking.bookings
         SET status='CancelledByClient', cancelled_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantA, firstId],
      );
      await insertConfirmed(pool, {
        ...base,
        id: randomUUID(),
        locationId: locationA2,
        priceKopecks: 0,
      });

      const confirmed = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM cookie_booking.bookings
         WHERE tenant_id=$1 AND staff_id=$2 AND status='Confirmed'`,
        [tenantA, staff],
      );
      assert.equal(confirmed.rows[0]?.count, "2");

      const constraint = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM pg_constraint
           WHERE conname='confirmed_staff_no_overlap'
         ) AS exists`,
      );
      assert.equal(constraint.rows[0]?.exists, true);
    } finally {
      if (first) {
        await first.query("ROLLBACK").catch(() => undefined);
        first.release();
      }
      if (second) {
        await second.query("ROLLBACK").catch(() => undefined);
        second.release();
      }
      // All fixtures are synthetic. Explicit cleanup is required because a
      // two-connection concurrency test needs COMMITTED tenant fixtures.
      for (const table of [
        "cookie_booking.bookings",
        "cookie_customers.customers",
        "cookie_staff.service_assignments",
        "cookie_staff.location_assignments",
        "cookie_staff.staff_profiles",
        "cookie_catalog.services",
        "cookie_tenancy.locations",
        "cookie_tenancy.organizations",
      ]) {
        await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [
          [tenantA, tenantB],
        ]).catch(() => undefined);
      }
      await pool.query("DELETE FROM cookie_identity.identities WHERE id=$1", [owner])
        .catch(() => undefined);
      await pool.end();
    }
  },
);
