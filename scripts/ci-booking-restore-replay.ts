// CI-only recovery probe using actual internal commands, never a runtime adapter.
import assert from "node:assert/strict";

import { Pool } from "pg";

import { cancelBookingInternal } from "../packages/domain-booking/src/cancel.js";
import { createBookingInternal } from "../packages/domain-booking/src/create.js";
import { rescheduleBookingInternal } from "../packages/domain-booking/src/reschedule.js";

const sourceUrl = "postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci";
const phase = process.argv[2];
if (
  process.env.CI !== "true" ||
  process.env.TEST_DATABASE_URL !== sourceUrl ||
  process.argv.length !== 3 ||
  (phase !== "seed" && phase !== "replay")
) {
  throw new Error("Refusing Booking recovery probe outside isolated CI");
}
const pool = new Pool({
  connectionString: phase === "seed" ? sourceUrl : sourceUrl + "_restore_smoke",
  application_name: "cookie-ci-booking-recovery",
  options: "-c timezone=UTC",
});
const tenant = "f2222222-2222-4222-8222-222222222222";
const owner = "f1111111-1111-4111-8111-111111111111";
const location = "f3333333-3333-4333-8333-333333333333";
const service = "f4444444-4444-4444-8444-444444444444";
const staff = "f5555555-5555-4555-8555-555555555555";
const customer = "f6666666-6666-4666-8666-666666666666";
const role = "f7777777-7777-4777-8777-777777777777";
const actor = { tenantId: tenant, identityId: owner, correlationId: "restore-command-probe" };

const create = {
  actor,
  customerId: customer,
  locationId: location,
  serviceId: service,
  staffId: staff,
  startAt: "2099-06-02T10:00:00Z",
  idempotencyKey: "restore-create-001",
};
const move = (bookingId: string) => ({
  actor,
  bookingId,
  newStartAt: "2099-06-02T12:00:00Z",
  idempotencyKey: "restore-move-001",
});
const cancel = (bookingId: string) => ({
  actor,
  bookingId,
  idempotencyKey: "restore-cancel-001",
});

async function seed() {
  // Only fixture setup uses SQL. All Booking/outbox/receipt/audit rows below
  // are produced by the real transaction commands.
  await pool.query(`
    INSERT INTO cookie_identity.identities(id) VALUES ('${owner}');
    INSERT INTO cookie_tenancy.organizations(id,owner_identity_id,display_name)
      VALUES ('${tenant}','${owner}','Synthetic command restore');
    INSERT INTO cookie_tenancy.locations(tenant_id,id,display_name,time_zone)
      VALUES ('${tenant}','${location}','Restore branch','UTC');
    INSERT INTO cookie_identity.memberships(tenant_id,identity_id)
      VALUES ('${tenant}','${owner}');
    INSERT INTO cookie_identity.roles(tenant_id,id,base_type,display_name,permissions)
      VALUES ('${tenant}','${role}','owner','Synthetic owner',
        ARRAY['booking.create','booking.cancel','booking.reschedule']);
    INSERT INTO cookie_identity.role_assignments(tenant_id,id,identity_id,role_id)
      VALUES ('${tenant}','f8888888-8888-4888-8888-888888888888','${owner}','${role}');
    INSERT INTO cookie_customers.customers(tenant_id,id) VALUES ('${tenant}','${customer}');
    INSERT INTO cookie_catalog.services(tenant_id,id,display_name,duration_minutes,
      post_service_buffer_minutes,base_price_kopecks,active)
      VALUES ('${tenant}','${service}','Synthetic service',60,10,150000,true);
    INSERT INTO cookie_staff.staff_profiles(tenant_id,id,display_name,active,bookable)
      VALUES ('${tenant}','${staff}','Synthetic staff',true,true);
    INSERT INTO cookie_staff.location_assignments(tenant_id,staff_id,location_id,active)
      VALUES ('${tenant}','${staff}','${location}',true);
    INSERT INTO cookie_staff.service_assignments(tenant_id,staff_id,location_id,service_id,active)
      VALUES ('${tenant}','${staff}','${location}','${service}',true);
    INSERT INTO cookie_scheduling.shift_windows(tenant_id,id,staff_id,location_id,start_at,end_at,active)
      VALUES ('${tenant}','f9999999-9999-4999-8999-999999999999','${staff}','${location}',
        '2099-06-02T09:00:00Z','2099-06-02T18:00:00Z',true);
  `);
  const allowSynthetic = async () => undefined;
  const created = await createBookingInternal(pool, create, allowSynthetic);
  assert.equal(created.priceKopecks, "150000");
  assert.equal(created.startAt, "2099-06-02T10:00:00.000Z");
  const moved = await rescheduleBookingInternal(pool, move(created.bookingId), allowSynthetic);
  assert.equal(moved.bookingId, created.bookingId);
  assert.equal(moved.priceKopecks, "150000");
  assert.equal(moved.startAt, "2099-06-02T12:00:00.000Z");
  assert.equal(moved.occupiedUntil, "2099-06-02T13:10:00.000Z");
  const cancelled = await cancelBookingInternal(pool, cancel(created.bookingId), allowSynthetic);
  assert.equal(cancelled.bookingId, created.bookingId);
  assert.equal(cancelled.status, "CancelledByBusiness");
}

async function snapshot(): Promise<string> {
  // Authorization audit is intentionally excluded: retry authorization may
  // append a new security audit. Business state must remain byte identical.
  const { rows } = await pool.query<{ projection: string }>(`
    SELECT jsonb_build_object(
      'bookings', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id)
        FROM cookie_booking.bookings b WHERE b.tenant_id=$1),
      'receipts', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.operation,r.key_sha256)
        FROM cookie_booking.command_receipts r WHERE r.tenant_id=$1),
      'cancellation', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
        FROM cookie_booking.booking_state_audit a WHERE a.tenant_id=$1),
      'movement', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
        FROM cookie_booking.time_change_audit a WHERE a.tenant_id=$1),
      'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id)
        FROM cookie_jobs.outbox_events e WHERE e.tenant_id=$1)
    )::text AS projection
  `, [tenant]);
  const value = rows[0]?.projection;
  assert.ok(value);
  const state = JSON.parse(value);
  assert.equal(state.bookings?.length, 1);
  assert.equal(state.bookings[0].status, "CancelledByBusiness");
  assert.equal(state.bookings[0].price_kopecks_snapshot, 150000);
  assert.equal(state.receipts?.length, 3);
  assert.equal(state.cancellation?.length, 1);
  assert.equal(state.movement?.length, 1);
  assert.equal(state.events?.length, 3);
  return value;
}

async function replay() {
  const before = await snapshot();
  const { rows } = await pool.query(
    "SELECT operation,booking_id::text,result FROM cookie_booking.command_receipts WHERE tenant_id=$1",
    [tenant],
  );
  const receipts = new Map(rows.map((row) => [row.operation, row]));
  const created = receipts.get("booking.create");
  const moved = receipts.get("booking.reschedule");
  const cancelled = receipts.get("booking.cancel");
  assert.ok(created && moved && cancelled);
  assert.equal(moved.booking_id, created.booking_id);
  assert.equal(cancelled.booking_id, created.booking_id);

  // Already committed operations must never execute their new-write policies.
  let calls = 0;
  const rejectNewWrite = async () => {
    calls++;
    throw new Error("Replay unexpectedly entered new-write policy");
  };
  assert.deepEqual(await createBookingInternal(pool, create, rejectNewWrite), created.result);
  assert.deepEqual(
    await rescheduleBookingInternal(pool, move(created.booking_id), rejectNewWrite),
    moved.result,
  );
  assert.deepEqual(
    await cancelBookingInternal(pool, cancel(created.booking_id), rejectNewWrite),
    cancelled.result,
  );
  await assert.rejects(
    createBookingInternal(pool, { ...create, startAt: "2099-06-02T11:00:00Z" }, rejectNewWrite),
    { code: "IDEMPOTENCY_KEY_REUSED" },
  );
  await assert.rejects(
    rescheduleBookingInternal(pool, { ...move(created.booking_id), newStartAt: "2099-06-02T14:00:00Z" }, rejectNewWrite),
    { code: "IDEMPOTENCY_KEY_REUSED" },
  );

  // A restored receipt is not an authorization grant.
  await pool.query("UPDATE cookie_identity.roles SET active=false WHERE tenant_id=$1 AND id=$2", [tenant, role]);
  try {
    await assert.rejects(createBookingInternal(pool, create, rejectNewWrite), { code: "ACCESS_DENIED" });
    await assert.rejects(rescheduleBookingInternal(pool, move(created.booking_id), rejectNewWrite), { code: "ACCESS_DENIED" });
    await assert.rejects(cancelBookingInternal(pool, cancel(created.booking_id), rejectNewWrite), { code: "ACCESS_DENIED" });
  } finally {
    await pool.query("UPDATE cookie_identity.roles SET active=true WHERE tenant_id=$1 AND id=$2", [tenant, role]);
  }
  assert.equal(calls, 0);
  assert.equal(await snapshot(), before, "replay changed durable business state");
}

try {
  const { rows } = await pool.query("SELECT current_database() AS name");
  assert.equal(rows[0]?.name, phase === "seed" ? "cookie_ci" : "cookie_ci_restore_smoke");
  if (phase === "seed") await seed();
  else await replay();
  // Consumed in shell, never published as a log or artifact.
  process.stdout.write(await snapshot());
} finally {
  await pool.end();
}
