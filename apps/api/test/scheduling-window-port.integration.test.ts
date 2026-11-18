import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  lockActiveBlockedWindows,
  lockActiveShiftWindows,
} from "../../../packages/domain-scheduling/src/index.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

test(
  "Scheduling window ports scope active rows and retain locks in caller transaction",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-scheduling-window-port",
      max: 4,
    });
    const owner = randomUUID();
    const tenant = randomUUID();
    const foreign = randomUUID();
    const staff = randomUUID();
    const location = randomUUID();
    const otherLocation = randomUUID();
    const otherStaff = randomUUID();
    const shift = randomUUID();
    const inactiveShift = randomUUID();
    const breakId = randomUUID();
    const exceptionId = randomUUID();
    const inactiveBlock = randomUUID();
    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      await pool.query(
        "INSERT INTO cookie_identity.identities(id) VALUES($1::uuid)",
        [owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
         VALUES($1,$3,'Window owner'),($2,$3,'Foreign tenant')`,
        [tenant, foreign, owner],
      );
      await pool.query(
        `INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
         VALUES($1,$3,'A','UTC'),($1,$4,'B','UTC'),($2,$3,'A foreign','UTC')`,
        [tenant, foreign, location, otherLocation],
      );
      await pool.query(
        `INSERT INTO cookie_staff.staff_profiles(tenant_id,id,display_name,active,bookable)
         VALUES($1,$3,'Staff A',true,true),($1,$4,'Staff B',true,true),
               ($2,$3,'Staff A foreign',true,true)`,
        [tenant, foreign, staff, otherStaff],
      );
      await pool.query(
        `INSERT INTO cookie_staff.location_assignments(tenant_id,staff_id,location_id,active)
         VALUES($1,$3,$5,true),($1,$3,$6,true),($1,$4,$5,true),($2,$3,$5,true)`,
        [tenant, foreign, staff, otherStaff, location, otherLocation],
      );

      async function addShift(
        tenantId: string,
        staffId: string,
        locationId: string,
        id: string,
        startAt: string,
        active: boolean,
      ) {
        await pool.query(
          `INSERT INTO cookie_scheduling.shift_windows
             (tenant_id,id,staff_id,location_id,start_at,end_at,active)
           VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz+interval '1 hour',$6)`,
          [tenantId, id, staffId, locationId, startAt, active],
        );
      }
      async function addBlock(
        tenantId: string,
        staffId: string,
        locationId: string,
        id: string,
        startAt: string,
        kind: "break" | "exception",
        active: boolean,
      ) {
        await pool.query(
          `INSERT INTO cookie_scheduling.blocked_windows
             (tenant_id,id,staff_id,location_id,start_at,end_at,kind,active)
           VALUES($1,$2,$3,$4,$5::timestamptz,$5::timestamptz+interval '15 minutes',$6,$7)`,
          [tenantId, id, staffId, locationId, startAt, kind, active],
        );
      }
      await addShift(
        tenant,
        staff,
        location,
        shift,
        "2027-05-01T10:00:00Z",
        true,
      );
      await addShift(
        tenant,
        staff,
        location,
        inactiveShift,
        "2027-05-01T12:00:00Z",
        false,
      );
      const otherShift = randomUUID();
      await addShift(
        tenant,
        staff,
        otherLocation,
        otherShift,
        "2027-05-01T14:00:00Z",
        true,
      );
      await addShift(
        tenant,
        otherStaff,
        location,
        randomUUID(),
        "2027-05-01T16:00:00Z",
        true,
      );
      await addShift(
        foreign,
        staff,
        location,
        shift,
        "2027-05-01T18:00:00Z",
        true,
      );
      await addBlock(
        tenant,
        staff,
        location,
        breakId,
        "2027-05-01T10:15:00Z",
        "break",
        true,
      );
      await addBlock(
        tenant,
        staff,
        location,
        exceptionId,
        "2027-05-01T10:30:00Z",
        "exception",
        true,
      );
      await addBlock(
        tenant,
        staff,
        location,
        inactiveBlock,
        "2027-05-01T12:15:00Z",
        "break",
        false,
      );
      await addBlock(
        tenant,
        staff,
        otherLocation,
        randomUUID(),
        "2027-05-01T14:15:00Z",
        "break",
        true,
      );
      await addBlock(
        foreign,
        staff,
        location,
        breakId,
        "2027-05-01T18:15:00Z",
        "break",
        true,
      );

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT id FROM cookie_staff.staff_profiles
            WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`,
          [tenant, staff],
        );
        const scope = {
          tenantId: tenant,
          staffId: staff,
          locationId: location,
        };
        assert.deepEqual(await lockActiveShiftWindows(client, scope), [
          {
            startAt: "2027-05-01T10:00:00.000Z",
            endAt: "2027-05-01T11:00:00.000Z",
          },
        ]);
        const blocks = await lockActiveBlockedWindows(client, scope);
        assert.deepEqual(
          blocks.sort((a, b) => a.startAt.localeCompare(b.startAt)),
          [
            {
              startAt: "2027-05-01T10:15:00.000Z",
              endAt: "2027-05-01T10:30:00.000Z",
              kind: "break",
            },
            {
              startAt: "2027-05-01T10:30:00.000Z",
              endAt: "2027-05-01T10:45:00.000Z",
              kind: "exception",
            },
          ],
        );
        const shiftProbe = `SELECT id FROM cookie_scheduling.shift_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE NOWAIT`;
        const blockProbe = `SELECT id FROM cookie_scheduling.blocked_windows
          WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE NOWAIT`;
        // A separate real DB connection cannot acquire a conflicting lock on
        // selected rows, but can lock inactive/other-branch/other-tenant rows.
        await assert.rejects(pool.query(shiftProbe, [tenant, shift]), {
          code: "55P03",
        });
        await assert.rejects(pool.query(blockProbe, [tenant, breakId]), {
          code: "55P03",
        });
        await assert.rejects(pool.query(blockProbe, [tenant, exceptionId]), {
          code: "55P03",
        });
        for (const args of [
          [tenant, inactiveShift],
          [tenant, otherShift],
          [foreign, shift],
        ]) {
          assert.equal((await pool.query(shiftProbe, args)).rowCount, 1);
        }
        for (const args of [
          [tenant, inactiveBlock],
          [foreign, breakId],
        ]) {
          assert.equal((await pool.query(blockProbe, args)).rowCount, 1);
        }
        await client.query("ROLLBACK");
        assert.equal(
          (await pool.query(shiftProbe, [tenant, shift])).rowCount,
          1,
        );
        assert.equal(
          (await pool.query(blockProbe, [tenant, breakId])).rowCount,
          1,
        );
      } finally {
        try {
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
    } finally {
      try {
        for (const table of [
          "cookie_scheduling.blocked_windows",
          "cookie_scheduling.shift_windows",
          "cookie_staff.location_assignments",
          "cookie_staff.staff_profiles",
          "cookie_tenancy.locations",
        ]) {
          await pool.query(
            `DELETE FROM ${table} WHERE tenant_id=ANY($1::uuid[])`,
            [[tenant, foreign]],
          );
        }
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id=ANY($1::uuid[])",
          [[tenant, foreign]],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id=$1::uuid",
          [owner],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
