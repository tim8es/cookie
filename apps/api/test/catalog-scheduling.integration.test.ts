import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool, type PoolClient } from "pg";

import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

async function rejectConstraint(
  client: PoolClient,
  query: string,
  parameters: readonly unknown[],
  code: "23503" | "23514",
): Promise<void> {
  await client.query("SAVEPOINT rejected_input");
  try {
    await assert.rejects(client.query(query, [...parameters]), { code });
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rejected_input");
    await client.query("RELEASE SAVEPOINT rejected_input");
  }
}

test(
  "F1 catalog/staff/scheduling persist tenant-scoped services, branches and absolute shifts",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-scheduling-persistence-test",
      max: 2,
    });
    let client: PoolClient | undefined;
    const owner = randomUUID();
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const locA1 = randomUUID();
    const locA2 = randomUUID();
    const locB = randomUUID();
    const serviceA = randomUUID();
    const serviceB = randomUUID();
    const staffA = randomUUID();
    const staffB = randomUUID();

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      client = await pool.connect();
      await client.query("BEGIN");

      await client.query("INSERT INTO cookie_identity.identities (id) VALUES ($1)", [owner]);
      await client.query(
        `INSERT INTO cookie_tenancy.organizations (id,owner_identity_id,display_name)
         VALUES ($1,$3,'Synthetic A'),($2,$3,'Synthetic B')`,
        [tenantA, tenantB, owner],
      );
      await client.query(
        `INSERT INTO cookie_tenancy.locations (tenant_id,id,display_name,time_zone)
         VALUES ($1,$2,'A1','Europe/Helsinki'),
                ($1,$3,'A2','Europe/Helsinki'),
                ($4,$5,'B','UTC')`,
        [tenantA, locA1, locA2, tenantB, locB],
      );
      const legacyLocation = await client.query<{time_zone: string | null}>(
        "SELECT time_zone FROM cookie_tenancy.locations WHERE tenant_id=$1 AND id=$2",
        [tenantA, locA1],
      );
      assert.equal(legacyLocation.rows[0]?.time_zone, "Europe/Helsinki");
      await rejectConstraint(
        client,
        `INSERT INTO cookie_tenancy.locations (tenant_id,id,display_name,time_zone)
         VALUES ($1,$2,'Invalid Zone','Europe Helsinki')`,
        [tenantA, randomUUID()],
        "23514",
      );

      await client.query(
        `INSERT INTO cookie_catalog.services
           (tenant_id,id,display_name,duration_minutes,post_service_buffer_minutes,base_price_kopecks)
         VALUES ($1,$2,'Synthetic haircut',60,10,150000),
                ($3,$4,'Synthetic other',30,0,50000)`,
        [tenantA, serviceA, tenantB, serviceB],
      );
      await client.query(
        `INSERT INTO cookie_staff.staff_profiles (tenant_id,id,display_name)
         VALUES ($1,$2,'Synthetic professional'),($3,$4,'Synthetic other staff')`,
        [tenantA, staffA, tenantB, staffB],
      );
      const initial = await client.query<{
        active: boolean;
        bookable: boolean;
        base_price_kopecks: string;
        duration_minutes: number;
        post_service_buffer_minutes: number;
      }>(
        `SELECT staff.active, staff.bookable, service.base_price_kopecks,
                service.duration_minutes, service.post_service_buffer_minutes
         FROM cookie_staff.staff_profiles AS staff
         JOIN cookie_catalog.services AS service ON service.tenant_id=staff.tenant_id
         WHERE staff.tenant_id=$1 AND staff.id=$2 AND service.id=$3`,
        [tenantA, staffA, serviceA],
      );
      assert.deepEqual(initial.rows, [
        {
          active: true,
          bookable: false,
          base_price_kopecks: "150000",
          duration_minutes: 60,
          post_service_buffer_minutes: 10,
        },
      ]);
      await rejectConstraint(
        client,
        `INSERT INTO cookie_catalog.services
         (tenant_id,id,display_name,duration_minutes,base_price_kopecks)
         VALUES($1,$2,'Bad',0,100)`,
        [tenantA, randomUUID()],
        "23514",
      );
      await rejectConstraint(
        client,
        `INSERT INTO cookie_catalog.services
         (tenant_id,id,display_name,duration_minutes,base_price_kopecks)
         VALUES($1,$2,'Bad',60,-1)`,
        [tenantA, randomUUID()],
        "23514",
      );
      await rejectConstraint(
        client,
        `UPDATE cookie_staff.staff_profiles SET active=false,bookable=true
          WHERE tenant_id=$1 AND id=$2`,
        [tenantA, staffA],
        "23514",
      );

      // One global StaffProfile is legitimately assigned to two locations.
      await client.query(
        `INSERT INTO cookie_staff.location_assignments(tenant_id,staff_id,location_id,active)
         VALUES($1,$2,$3,true),($1,$2,$4,true)`,
        [tenantA, staffA, locA1, locA2],
      );
      await client.query(
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id,active)
         VALUES($1,$2,$3,$5,true),($1,$2,$4,$5,true)`,
        [tenantA, staffA, locA1, locA2, serviceA],
      );

      const assignments = await client.query<{ staff_id: string; count: string }>(
        `SELECT staff_id::text, count(*)::text AS count
           FROM cookie_staff.location_assignments
           WHERE tenant_id=$1 GROUP BY staff_id`,
        [tenantA],
      );
      assert.deepEqual(assignments.rows, [{ staff_id: staffA, count: "2" }]);

      await rejectConstraint(
        client,
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id) VALUES($1,$2,$3)`,
        [tenantA, staffA, locB],
        "23503",
      );
      await rejectConstraint(
        client,
        `INSERT INTO cookie_staff.location_assignments
           (tenant_id,staff_id,location_id) VALUES($1,$2,$3)`,
        [tenantB, staffA, locB],
        "23503",
      );
      await rejectConstraint(
        client,
        `INSERT INTO cookie_staff.service_assignments
           (tenant_id,staff_id,location_id,service_id)
         VALUES($1,$2,$3,$4)`,
        [tenantA, staffA, locA1, serviceB],
        "23503",
      );

      const shiftA1 = randomUUID();
      const shiftA2 = randomUUID();
      await client.query(
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at,active)
         VALUES($1,$2,$3,$4,'2026-11-15T08:00:00Z','2026-11-15T12:00:00Z',true),
               ($1,$5,$3,$6,'2026-11-16T08:00:00Z','2026-11-16T12:00:00Z',true)`,
        [tenantA, shiftA1, staffA, locA1, shiftA2, locA2],
      );
      await client.query(
        `INSERT INTO cookie_scheduling.blocked_windows
           (tenant_id,id,staff_id,location_id,kind,start_at,end_at,active)
         VALUES($1,$2,$3,$4,'break','2026-11-15T09:00:00Z','2026-11-15T09:30:00Z',true),
               ($1,$5,$3,$4,'exception','2026-11-15T10:00:00Z','2026-11-15T10:20:00Z',true)`,
        [tenantA, randomUUID(), staffA, locA1, randomUUID()],
      );
      const blocks = await client.query<{ kind: string }>(
        `SELECT kind FROM cookie_scheduling.blocked_windows
         WHERE tenant_id=$1 AND staff_id=$2 ORDER BY kind`,
        [tenantA, staffA],
      );
      assert.deepEqual(blocks.rows, [{ kind: "break" }, { kind: "exception" }]);

      await rejectConstraint(
        client,
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at)
         VALUES($1,$2,$3,$4,'2026-11-15T11:00:00Z','2026-11-15T10:00:00Z')`,
        [tenantA, randomUUID(), staffA, locA1],
        "23514",
      );
      await rejectConstraint(
        client,
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at)
         VALUES($1,$2,$3,$4,'2026-11-15T10:00:00Z','2026-11-17T11:00:00Z')`,
        [tenantA, randomUUID(), staffA, locA1],
        "23514",
      );
      await rejectConstraint(
        client,
        `INSERT INTO cookie_scheduling.shift_windows
           (tenant_id,id,staff_id,location_id,start_at,end_at)
         VALUES($1,$2,$3,$4,'2026-11-15T10:00:00Z','2026-11-15T11:00:00Z')`,
        [tenantB, randomUUID(), staffA, locB],
        "23503",
      );
      await rejectConstraint(
        client,
        `INSERT INTO cookie_scheduling.blocked_windows
           (tenant_id,id,staff_id,location_id,kind,start_at,end_at)
         VALUES($1,$2,$3,$4,'meeting','2026-11-15T10:00:00Z','2026-11-15T11:00:00Z')`,
        [tenantA, randomUUID(), staffA, locA1],
        "23514",
      );
      await rejectConstraint(
        client,
        `INSERT INTO cookie_scheduling.blocked_windows
           (tenant_id,id,staff_id,location_id,kind,start_at,end_at)
         VALUES($1,$2,$3,$4,'break','2026-11-15T10:00:00Z','2026-11-15T11:00:00Z')`,
        [tenantA, randomUUID(), staffA, locB],
        "23503",
      );

      const scoped = await client.query<{count: string}>(
        `SELECT count(*)::text AS count
         FROM cookie_scheduling.shift_windows
         WHERE tenant_id=$1 AND staff_id=$2`,
        [tenantB, staffA],
      );
      assert.equal(scoped.rows[0]?.count, "0");
    } finally {
      if (client) {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
      await pool.end();
    }
  },
);
