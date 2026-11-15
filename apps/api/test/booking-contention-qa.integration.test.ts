import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";

import { Pool } from "pg";

import {
  createBookingInternal,
  type ConfirmedBookingReceipt,
  type InternalCreateBooking,
} from "../../../packages/domain-booking/src/create.js";
import { runMigrations } from "../../../packages/platform-db/src/migrations.js";

interface SyntheticTenant {
  readonly id: string;
  readonly owner: string;
  readonly customer: string;
  readonly locations: readonly [string, string];
  readonly role: string;
}

test(
  "24 concurrent cross-branch booking commands never duplicate tenant bookings, receipts or outbox",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      application_name: "cookie-qa-booking-concurrency",
      max: 20,
      connectionTimeoutMillis: 5_000,
    });
    const staffId = randomUUID();
    const serviceId = randomUUID();
    const tenants: SyntheticTenant[] = Array.from({ length: 2 }, () => ({
      id: randomUUID(),
      owner: randomUUID(),
      customer: randomUUID(),
      locations: [randomUUID(), randomUUID()] as const,
      role: randomUUID(),
    }));
    const tenantIds = tenants.map((tenant) => tenant.id);
    const sameSlot = "2027-07-20T10:00:00Z";
    const allowedSyntheticEntitlement = async (): Promise<void> => undefined;

    try {
      await runMigrations(pool, resolve(process.cwd(), "db/migrations"));
      for (const tenant of tenants) {
        await pool.query(
          "INSERT INTO cookie_identity.identities(id) VALUES ($1::uuid)",
          [tenant.owner],
        );
        await pool.query(
          `INSERT INTO cookie_tenancy.organizations(id, owner_identity_id, display_name)
           VALUES ($1::uuid, $2::uuid, 'Synthetic concurrent tenant')`,
          [tenant.id, tenant.owner],
        );
        await pool.query(
          `INSERT INTO cookie_tenancy.locations(tenant_id, id, display_name, time_zone)
           VALUES ($1::uuid, $2::uuid, 'A', 'UTC'),
                  ($1::uuid, $3::uuid, 'B', 'UTC')`,
          [tenant.id, ...tenant.locations],
        );
        await pool.query(
          `INSERT INTO cookie_identity.memberships(tenant_id, identity_id)
           VALUES ($1::uuid, $2::uuid)`,
          [tenant.id, tenant.owner],
        );
        await pool.query(
          `INSERT INTO cookie_identity.roles
             (tenant_id, id, base_type, display_name, permissions)
           VALUES ($1::uuid, $2::uuid, 'owner', 'Synthetic owner',
                   ARRAY['booking.create'])`,
          [tenant.id, tenant.role],
        );
        await pool.query(
          `INSERT INTO cookie_identity.role_assignments
             (tenant_id, id, identity_id, role_id)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
          [tenant.id, randomUUID(), tenant.owner, tenant.role],
        );
        await pool.query(
          "INSERT INTO cookie_customers.customers(tenant_id, id) VALUES ($1::uuid, $2::uuid)",
          [tenant.id, tenant.customer],
        );
        await pool.query(
          `INSERT INTO cookie_catalog.services
             (tenant_id, id, display_name, duration_minutes,
              post_service_buffer_minutes, base_price_kopecks, active)
           VALUES ($1::uuid, $2::uuid, 'Synthetic service', 60, 10, 150000, true)`,
          [tenant.id, serviceId],
        );
        await pool.query(
          `INSERT INTO cookie_staff.staff_profiles
             (tenant_id, id, display_name, active, bookable)
           VALUES ($1::uuid, $2::uuid, 'Synthetic staff', true, true)`,
          [tenant.id, staffId],
        );
        for (const locationId of tenant.locations) {
          await pool.query(
            `INSERT INTO cookie_staff.location_assignments
               (tenant_id, staff_id, location_id, active)
             VALUES ($1::uuid, $2::uuid, $3::uuid, true)`,
            [tenant.id, staffId, locationId],
          );
          await pool.query(
            `INSERT INTO cookie_staff.service_assignments
               (tenant_id, staff_id, location_id, service_id, active)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true)`,
            [tenant.id, staffId, locationId, serviceId],
          );
          await pool.query(
            `INSERT INTO cookie_scheduling.shift_windows
               (tenant_id, id, staff_id, location_id, start_at, end_at, active)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
                     '2027-07-20T09:00:00Z', '2027-07-20T18:00:00Z', true)`,
            [tenant.id, randomUUID(), staffId, locationId],
          );
        }
      }

      // Concurrent independent keys, across both branches of two different
      // tenants. The same StaffProfile UUID intentionally exists in each
      // tenant: neither locks nor booking exclusions may leak cross-tenant.
      const commands: InternalCreateBooking[] = tenants.flatMap((tenant) =>
        Array.from({ length: 12 }, (_, index) => ({
          actor: {
            tenantId: tenant.id,
            identityId: tenant.owner,
            correlationId: "synthetic-qa-contention",
          },
          customerId: tenant.customer,
          locationId: tenant.locations[index % 2]!,
          staffId,
          serviceId,
          startAt: sameSlot,
          idempotencyKey: `parallel-channel-${index}`,
        })),
      );
      const results = await Promise.allSettled(
        commands.map((command) =>
          createBookingInternal(pool, command, allowedSyntheticEntitlement),
        ),
      );

      for (let index = 0; index < tenants.length; index++) {
        const tenant = tenants[index]!;
        const start = index * 12;
        const batch = results.slice(start, start + 12);
        const successes = batch.flatMap((result, offset) =>
          result.status === "fulfilled"
            ? [{ receipt: result.value, command: commands[start + offset]! }]
            : [],
        );
        assert.equal(
          successes.length,
          1,
          "exactly one cross-branch booking may reserve one staff interval per tenant",
        );
        for (const result of batch) {
          if (result.status === "rejected") {
            const code = (result.reason as { code?: string }).code;
            assert.ok(
              code === "BOOKING_NOT_AVAILABLE" || code === "BOOKING_CONFLICT",
              "contending requests must fail with an explicit availability/conflict code",
            );
          }
        }

        const persisted = await pool.query<{
          confirmed: string;
          bookings: string;
          receipts: string;
          events: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM cookie_booking.bookings
               WHERE tenant_id=$1::uuid AND status='Confirmed') AS confirmed,
             (SELECT count(*)::text FROM cookie_booking.bookings
               WHERE tenant_id=$1::uuid) AS bookings,
             (SELECT count(*)::text FROM cookie_booking.command_receipts
               WHERE tenant_id=$1::uuid AND operation='booking.create') AS receipts,
             (SELECT count(*)::text FROM cookie_jobs.outbox_events
               WHERE tenant_id=$1::uuid AND topic='booking.confirmed') AS events`,
          [tenant.id],
        );
        assert.deepEqual(persisted.rows[0], {
          confirmed: "1",
          bookings: "1",
          receipts: "1",
          events: "1",
        });

        const winner = successes[0]!;
        assert.equal(winner.receipt.status, "Confirmed");
        assert.equal(winner.receipt.priceKopecks, "150000");

        const event = await pool.query<{ booking_id: string }>(
          `SELECT payload->>'bookingId' AS booking_id
           FROM cookie_jobs.outbox_events
           WHERE tenant_id=$1::uuid AND topic='booking.confirmed'`,
          [tenant.id],
        );
        assert.equal(event.rows[0]?.booking_id, winner.receipt.bookingId);

        // Concurrent same-key retries, representing repeated delivery from
        // independent API channels, must all return the same persisted receipt
        // without redoing the entitlement check or creating new events.
        const prohibitEntitlementOnReplay = async (): Promise<void> => {
          throw new Error("entitlement must not run for a committed retry");
        };
        const repeats: ConfirmedBookingReceipt[] = await Promise.all(
          Array.from({ length: 12 }, () =>
            createBookingInternal(
              pool,
              winner.command,
              prohibitEntitlementOnReplay,
            ),
          ),
        );
        for (const replay of repeats) {
          assert.deepEqual(replay, winner.receipt);
        }

        const afterRetries = await pool.query<{
          bookings: string;
          receipts: string;
          events: string;
        }>(
          `SELECT
             (SELECT count(*)::text FROM cookie_booking.bookings
               WHERE tenant_id=$1::uuid) AS bookings,
             (SELECT count(*)::text FROM cookie_booking.command_receipts
               WHERE tenant_id=$1::uuid) AS receipts,
             (SELECT count(*)::text FROM cookie_jobs.outbox_events
               WHERE tenant_id=$1::uuid) AS events`,
          [tenant.id],
        );
        assert.deepEqual(afterRetries.rows[0], {
          bookings: "1",
          receipts: "1",
          events: "1",
        });

        await assert.rejects(
          createBookingInternal(
            pool,
            {
              ...winner.command,
              locationId:
                tenant.locations[1] === winner.command.locationId
                  ? tenant.locations[0]
                  : tenant.locations[1],
            },
            allowedSyntheticEntitlement,
          ),
          { code: "IDEMPOTENCY_KEY_REUSED" },
        );
      }

      // A client from tenant A cannot persist a foreign tenant B customer
      // through a newly available, non-conflicting staff interval.
      await assert.rejects(
        createBookingInternal(
          pool,
          {
            ...commands[0]!,
            customerId: tenants[1]!.customer,
            startAt: "2027-07-20T13:00:00Z",
            idempotencyKey: "foreign-customer-guard",
          },
          allowedSyntheticEntitlement,
        ),
        { code: "BOOKING_NOT_AVAILABLE" },
      );
    } finally {
      const scopedTables = [
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
        for (const table of scopedTables) {
          await pool
            .query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [
              tenantIds,
            ])
            .catch(() => undefined);
        }
        await pool.query(
          "DELETE FROM cookie_tenancy.organizations WHERE id = ANY($1::uuid[])",
          [tenantIds],
        );
        await pool.query(
          "DELETE FROM cookie_identity.identities WHERE id = ANY($1::uuid[])",
          [tenants.map((tenant) => tenant.owner)],
        );
      } finally {
        await pool.end();
      }
    }
  },
);
