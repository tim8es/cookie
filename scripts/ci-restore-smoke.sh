#!/usr/bin/env bash
set -euo pipefail

# Synthetic-only CI restore proof. Never point this script at a live database.
EXPECTED_URL="postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci"
if [[ "${CI:-}" != "true" || "${TEST_DATABASE_URL:-}" != "$EXPECTED_URL" ]]; then
  echo "Refusing restore smoke outside the exact isolated CI database" >&2
  exit 2
fi

expected_migration_count="$(find db/migrations -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')"
temp_dir="$(mktemp -d)"
restore_created=false
pg_tool() {
  docker run --rm -i --network host \
    -e PGPASSWORD=cookie_ci \
    -v "$temp_dir:/backup" \
    postgres:16-alpine "$@"
}
cleanup() {
  if [[ "$restore_created" == "true" ]]; then
    pg_tool dropdb --if-exists -h 127.0.0.1 -U cookie_ci cookie_ci_restore_smoke >/dev/null || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT

# Seed an isolated, unmistakably synthetic committed event after integration
# tests; the backup must capture both an authoritative organization and outbox.
pg_tool psql -X -v ON_ERROR_STOP=1 -h 127.0.0.1 -U cookie_ci -d cookie_ci <<'SQL'
BEGIN;
INSERT INTO cookie_identity.identities (id)
VALUES ('e1111111-1111-4111-8111-111111111111')
ON CONFLICT DO NOTHING;

INSERT INTO cookie_tenancy.organizations (id, owner_identity_id, display_name)
VALUES (
  'e2222222-2222-4222-8222-222222222222',
  'e1111111-1111-4111-8111-111111111111',
  'Synthetic restore smoke'
)
ON CONFLICT DO NOTHING;

INSERT INTO cookie_jobs.outbox_events
  (id, tenant_id, dedupe_key, topic, payload, fingerprint, max_attempts)
VALUES (
  'e3333333-3333-4333-8333-333333333333',
  'e2222222-2222-4222-8222-222222222222',
  'restore-smoke-001',
  'booking.confirmed',
  '{"synthetic":true}'::jsonb,
  repeat('a', 64),
  5
)
ON CONFLICT (tenant_id, dedupe_key) DO NOTHING;

-- CI-only storage fixture, not evidence of authorization or a domain command.
INSERT INTO cookie_identity.memberships (tenant_id, identity_id)
VALUES ('e2222222-2222-4222-8222-222222222222', 'e1111111-1111-4111-8111-111111111111');
INSERT INTO cookie_tenancy.locations (tenant_id, id, display_name, time_zone)
VALUES ('e2222222-2222-4222-8222-222222222222', 'e4444444-4444-4444-8444-444444444441', 'Restore A', 'Europe/Moscow'),
       ('e2222222-2222-4222-8222-222222222222', 'e4444444-4444-4444-8444-444444444442', 'Restore B', 'Europe/Moscow');
INSERT INTO cookie_catalog.services
  (tenant_id, id, display_name, duration_minutes, post_service_buffer_minutes, base_price_kopecks)
VALUES ('e2222222-2222-4222-8222-222222222222', 'e5555555-5555-4555-8555-555555555555', 'Synthetic restore service', 60, 10, 180000);
INSERT INTO cookie_staff.staff_profiles (tenant_id, id, display_name)
VALUES ('e2222222-2222-4222-8222-222222222222', 'e6666666-6666-4666-8666-666666666666', 'Synthetic restore staff');
INSERT INTO cookie_staff.location_assignments (tenant_id, staff_id, location_id)
VALUES ('e2222222-2222-4222-8222-222222222222', 'e6666666-6666-4666-8666-666666666666', 'e4444444-4444-4444-8444-444444444441'),
       ('e2222222-2222-4222-8222-222222222222', 'e6666666-6666-4666-8666-666666666666', 'e4444444-4444-4444-8444-444444444442');
INSERT INTO cookie_staff.service_assignments (tenant_id, staff_id, location_id, service_id)
VALUES ('e2222222-2222-4222-8222-222222222222', 'e6666666-6666-4666-8666-666666666666', 'e4444444-4444-4444-8444-444444444441', 'e5555555-5555-4555-8555-555555555555'),
       ('e2222222-2222-4222-8222-222222222222', 'e6666666-6666-4666-8666-666666666666', 'e4444444-4444-4444-8444-444444444442', 'e5555555-5555-4555-8555-555555555555');
INSERT INTO cookie_customers.customers (tenant_id, id)
VALUES ('e2222222-2222-4222-8222-222222222222', 'e7777777-7777-4777-8777-777777777777');
INSERT INTO cookie_booking.bookings
  (tenant_id, id, customer_id, staff_id, location_id, service_id, status,
   start_at, end_at, occupied_until, service_duration_minutes_snapshot,
   post_service_buffer_minutes_snapshot, price_kopecks_snapshot, cancelled_at)
VALUES
  ('e2222222-2222-4222-8222-222222222222', 'e8888888-8888-4888-8888-888888888881', 'e7777777-7777-4777-8777-777777777777', 'e6666666-6666-4666-8666-666666666666', 'e4444444-4444-4444-8444-444444444441', 'e5555555-5555-4555-8555-555555555555',
   'Confirmed', '2099-06-01 09:00+00', '2099-06-01 10:00+00', '2099-06-01 10:10+00', 60, 10, 150000, NULL),
  ('e2222222-2222-4222-8222-222222222222', 'e8888888-8888-4888-8888-888888888882', 'e7777777-7777-4777-8777-777777777777', 'e6666666-6666-4666-8666-666666666666', 'e4444444-4444-4444-8444-444444444442', 'e5555555-5555-4555-8555-555555555555',
   'CancelledByBusiness', '2099-06-01 09:00+00', '2099-06-01 10:00+00', '2099-06-01 10:10+00', 60, 10, 150000,
   '2099-05-31 09:00+00');
INSERT INTO cookie_booking.command_receipts
  (tenant_id, actor_identity_id, operation, key_sha256, request_sha256, booking_id, result)
VALUES
  ('e2222222-2222-4222-8222-222222222222', 'e1111111-1111-4111-8111-111111111111', 'booking.create', repeat('b', 64), repeat('c', 64), 'e8888888-8888-4888-8888-888888888881',
   '{"bookingId":"e8888888-8888-4888-8888-888888888881","status":"Confirmed","startAt":"2099-06-01T09:00:00.000Z","endAt":"2099-06-01T10:00:00.000Z","occupiedUntil":"2099-06-01T10:10:00.000Z","priceKopecks":"150000"}'),
  ('e2222222-2222-4222-8222-222222222222', 'e1111111-1111-4111-8111-111111111111', 'booking.cancel', repeat('d', 64), repeat('e', 64), 'e8888888-8888-4888-8888-888888888882',
   '{"bookingId":"e8888888-8888-4888-8888-888888888882","status":"CancelledByBusiness","cancelledAt":"2099-05-31T09:00:00.000Z"}');
INSERT INTO cookie_booking.booking_state_audit
  (tenant_id, id, booking_id, actor_identity_id, correlation_id, command, previous_status, next_status)
VALUES ('e2222222-2222-4222-8222-222222222222', 'e9999999-9999-4999-8999-999999999999', 'e8888888-8888-4888-8888-888888888882', 'e1111111-1111-4111-8111-111111111111', 'restore-smoke-cancel',
        'booking.cancel', 'Confirmed', 'CancelledByBusiness');
COMMIT;
SQL

# Fail before dumping if Docker did not forward the SQL heredoc or seed failed.
source_count="$(pg_tool psql -X -Atq -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -U cookie_ci -d cookie_ci -c "
    SELECT count(*) FROM cookie_jobs.outbox_events
    WHERE id = 'e3333333-3333-4333-8333-333333333333';
  ")"
if [[ "$source_count" != "1" ]]; then
  echo "Synthetic source event was not inserted; refusing to create a misleading backup" >&2
  exit 1
fi

# Dumped data must retain the complete synthetic Booking storage projection.
# Compare against the source AND explicitly test expected values in both.
booking_projection() {
  pg_tool psql -X -Atq -v ON_ERROR_STOP=1 -h 127.0.0.1 -U cookie_ci -d "$1" <<'SQL'
SET TIME ZONE 'UTC';
SELECT jsonb_build_object(
  'bookings', (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id)
    FROM cookie_booking.bookings b WHERE b.tenant_id = 'e2222222-2222-4222-8222-222222222222'),
  'receipts', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.operation, r.key_sha256)
    FROM cookie_booking.command_receipts r WHERE r.tenant_id = 'e2222222-2222-4222-8222-222222222222'),
  'audit', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id)
    FROM cookie_booking.booking_state_audit a WHERE a.tenant_id = 'e2222222-2222-4222-8222-222222222222'),
  'service', (SELECT to_jsonb(s) FROM cookie_catalog.services s
    WHERE s.tenant_id = 'e2222222-2222-4222-8222-222222222222' AND s.id = 'e5555555-5555-4555-8555-555555555555')
);
SQL
}
verify_booking_fixture() {
  pg_tool psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U cookie_ci -d "$1" <<'SQL'
DO $verify$
BEGIN
  IF (SELECT count(*) FROM cookie_booking.bookings WHERE tenant_id = 'e2222222-2222-4222-8222-222222222222') <> 2
     OR NOT EXISTS (
       SELECT 1 FROM cookie_booking.bookings b
       JOIN cookie_catalog.services s ON (s.tenant_id,s.id) = (b.tenant_id,b.service_id)
       WHERE b.tenant_id = 'e2222222-2222-4222-8222-222222222222' AND b.id = 'e8888888-8888-4888-8888-888888888881'
         AND b.customer_id = 'e7777777-7777-4777-8777-777777777777' AND b.staff_id = 'e6666666-6666-4666-8666-666666666666'
         AND b.location_id = 'e4444444-4444-4444-8444-444444444441' AND b.service_id = 'e5555555-5555-4555-8555-555555555555'
         AND b.status = 'Confirmed' AND b.cancelled_at IS NULL
         AND b.start_at = '2099-06-01 09:00+00' AND b.end_at = '2099-06-01 10:00+00'
         AND b.occupied_until = '2099-06-01 10:10+00'
         AND b.service_duration_minutes_snapshot = 60
         AND b.post_service_buffer_minutes_snapshot = 10
         AND b.price_kopecks_snapshot = 150000 AND s.base_price_kopecks = 180000
     ) OR NOT EXISTS (
       SELECT 1 FROM cookie_booking.bookings b
       WHERE b.tenant_id = 'e2222222-2222-4222-8222-222222222222' AND b.id = 'e8888888-8888-4888-8888-888888888882'
         AND b.status = 'CancelledByBusiness' AND b.location_id = 'e4444444-4444-4444-8444-444444444442'
         AND b.cancelled_at = '2099-05-31 09:00+00'
     ) OR (SELECT count(*) FROM cookie_booking.command_receipts
           WHERE tenant_id = 'e2222222-2222-4222-8222-222222222222') <> 2
     OR NOT EXISTS (
       SELECT 1 FROM cookie_booking.command_receipts
       WHERE tenant_id = 'e2222222-2222-4222-8222-222222222222' AND actor_identity_id = 'e1111111-1111-4111-8111-111111111111'
         AND operation = 'booking.create' AND booking_id = 'e8888888-8888-4888-8888-888888888881'
         AND key_sha256 = repeat('b', 64) AND request_sha256 = repeat('c', 64)
         AND result->>'priceKopecks' = '150000' AND result->>'status' = 'Confirmed'
     ) OR NOT EXISTS (
       SELECT 1 FROM cookie_booking.command_receipts
       WHERE tenant_id = 'e2222222-2222-4222-8222-222222222222' AND actor_identity_id = 'e1111111-1111-4111-8111-111111111111'
         AND operation = 'booking.cancel' AND booking_id = 'e8888888-8888-4888-8888-888888888882'
         AND key_sha256 = repeat('d', 64) AND request_sha256 = repeat('e', 64)
         AND result->>'status' = 'CancelledByBusiness'
     ) OR NOT EXISTS (
       SELECT 1 FROM cookie_booking.booking_state_audit
       WHERE tenant_id = 'e2222222-2222-4222-8222-222222222222' AND id = 'e9999999-9999-4999-8999-999999999999'
         AND booking_id = 'e8888888-8888-4888-8888-888888888882' AND actor_identity_id = 'e1111111-1111-4111-8111-111111111111'
         AND command = 'booking.cancel' AND previous_status = 'Confirmed'
         AND next_status = 'CancelledByBusiness'
     )
  THEN
    RAISE EXCEPTION 'Synthetic Booking fixture incomplete';
  END IF;
END
$verify$;
SQL
}

# A catalog entry alone is insufficient: exercise the restored constraint.
# All probe writes are rolled back, including the allowed adjacent booking.
verify_restored_exclusion() {
  pg_tool psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U cookie_ci -d "$1" <<'SQL'
BEGIN;
DO $probe$
DECLARE rejected_constraint text;
BEGIN
  BEGIN
    INSERT INTO cookie_booking.bookings
      (tenant_id, id, customer_id, staff_id, location_id, service_id, status,
       start_at, end_at, occupied_until, service_duration_minutes_snapshot,
       post_service_buffer_minutes_snapshot, price_kopecks_snapshot)
    SELECT tenant_id, 'e8888888-8888-4888-8888-888888888883', customer_id, staff_id, 'e4444444-4444-4444-8444-444444444442', service_id,
           'Confirmed', '2099-06-01 10:05+00', '2099-06-01 11:05+00', '2099-06-01 11:15+00',
           60, 10, 150000
    FROM cookie_booking.bookings WHERE tenant_id = 'e2222222-2222-4222-8222-222222222222' AND id = 'e8888888-8888-4888-8888-888888888881';
    RAISE EXCEPTION 'Restored DB accepted cross-branch overlap with post-service buffer';
  EXCEPTION WHEN exclusion_violation THEN
    GET STACKED DIAGNOSTICS rejected_constraint = CONSTRAINT_NAME;
    IF rejected_constraint IS DISTINCT FROM 'confirmed_staff_no_overlap' THEN
      RAISE;
    END IF;
  END;

  INSERT INTO cookie_booking.bookings
    (tenant_id, id, customer_id, staff_id, location_id, service_id, status,
     start_at, end_at, occupied_until, service_duration_minutes_snapshot,
     post_service_buffer_minutes_snapshot, price_kopecks_snapshot)
  SELECT tenant_id, 'e8888888-8888-4888-8888-888888888884', customer_id, staff_id, 'e4444444-4444-4444-8444-444444444442', service_id,
         'Confirmed', '2099-06-01 10:10+00', '2099-06-01 11:10+00', '2099-06-01 11:20+00',
         60, 10, 150000
  FROM cookie_booking.bookings WHERE tenant_id = 'e2222222-2222-4222-8222-222222222222' AND id = 'e8888888-8888-4888-8888-888888888881';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Adjacent Booking probe did not insert';
  END IF;
END
$probe$;
ROLLBACK;
SQL
}

verify_booking_fixture cookie_ci
source_booking_projection="$(booking_projection cookie_ci)"
source_command_projection="$(pnpm exec tsx scripts/ci-booking-restore-replay.ts seed)"
[[ -n "$source_command_projection" ]] || { echo "Missing source command evidence" >&2; exit 1; }

# Use the same PostgreSQL major version on both sides. No dump is uploaded.
pg_tool pg_dump -h 127.0.0.1 -U cookie_ci -d cookie_ci \
  --format=custom --file=/backup/cookie.dump

pg_tool createdb -h 127.0.0.1 -U cookie_ci cookie_ci_restore_smoke
restore_created=true

pg_tool pg_restore -h 127.0.0.1 -U cookie_ci -d cookie_ci_restore_smoke \
  --no-owner --no-acl --exit-on-error /backup/cookie.dump

result="$(pg_tool psql -X -Atq -v ON_ERROR_STOP=1 \
  -h 127.0.0.1 -U cookie_ci -d cookie_ci_restore_smoke -c "
    SELECT CASE WHEN
      (SELECT count(*) FROM public.cookie_schema_migrations) = ${expected_migration_count}
      AND to_regclass('cookie_tenancy.owner_setup_receipts') IS NOT NULL
      AND to_regclass('cookie_appearance.organization_branding') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM cookie_jobs.outbox_events AS event
        JOIN cookie_tenancy.organizations AS org ON org.id = event.tenant_id
        WHERE event.id = 'e3333333-3333-4333-8333-333333333333'
          AND event.status = 'pending'
          AND event.payload = '{\"synthetic\":true}'::jsonb
          AND org.display_name = 'Synthetic restore smoke'
      )
      AND to_regclass('cookie_customers.customers') IS NOT NULL
      AND to_regclass('cookie_identity.opaque_sessions') IS NOT NULL
      AND to_regclass('cookie_identity.telegram_identity_links') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='revoke_opaque_sessions_on_telegram_unlink' AND NOT tgisinternal)
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='cookie_identity' AND indexname='telegram_link_active_tenant_user')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='cookie_identity' AND indexname='opaque_sessions_retention_oldest_idx')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='cookie_identity' AND indexname='opaque_sessions_retention_member_idx')
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='cookie_identity' AND table_name='opaque_sessions'
          AND column_name='telegram_link_id')
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='revoke_opaque_sessions_on_membership_disable' AND NOT tgisinternal)
      AND to_regclass('cookie_booking.bookings') IS NOT NULL
      AND to_regclass('cookie_booking.command_receipts') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='confirmed_staff_no_overlap' AND contype='x')
      AND to_regclass('cookie_catalog.services') IS NOT NULL
      AND to_regclass('cookie_staff.staff_profiles') IS NOT NULL
      AND to_regclass('cookie_staff.location_assignments') IS NOT NULL
      AND to_regclass('cookie_staff.service_assignments') IS NOT NULL
      AND to_regclass('cookie_scheduling.shift_windows') IS NOT NULL
      AND to_regclass('cookie_scheduling.blocked_windows') IS NOT NULL
      AND to_regclass('cookie_scheduling.shift_disable_receipts') IS NOT NULL
      AND to_regclass('cookie_scheduling.shift_disable_audit') IS NOT NULL
      AND to_regclass('cookie_scheduling.shift_publish_receipts') IS NOT NULL
      AND to_regclass('cookie_scheduling.shift_publish_audit') IS NOT NULL
      AND to_regclass('cookie_scheduling.shift_draft_receipts') IS NOT NULL
      AND to_regclass('cookie_scheduling.shift_draft_audit') IS NOT NULL
      AND to_regclass('cookie_scheduling.shift_edit_receipts') IS NOT NULL
      AND to_regclass('cookie_scheduling.shift_edit_audit') IS NOT NULL
      AND to_regclass('cookie_jobs.outbox_alert_state') IS NOT NULL
      AND to_regclass('cookie_jobs.outbox_alert_transitions') IS NOT NULL
      AND to_regclass('cookie_jobs.outbox_alert_delivery') IS NOT NULL
      AND to_regclass('cookie_jobs.outbox_alert_replay_audit') IS NOT NULL
      AND to_regclass('cookie_jobs.outbox_alert_replay_receipts') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='cookie_jobs' AND table_name='outbox_alert_delivery'
          AND column_name='lease_started_at')
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='cookie_jobs' AND table_name='outbox_alert_delivery'
          AND column_name='manual_replay_count')
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='enqueue_alert_transition_delivery' AND NOT tgisinternal)
      AND to_regclass('cookie_scheduling.schedule_edit_policies') IS NOT NULL
      AND to_regclass('cookie_scheduling.schedule_edit_policy_audit') IS NOT NULL
      AND to_regclass('cookie_scheduling.schedule_edit_requests') IS NOT NULL
      AND to_regclass('cookie_scheduling.schedule_disable_requests') IS NOT NULL
      AND to_regclass('cookie_scheduling.schedule_publish_requests') IS NOT NULL
      AND to_regclass('cookie_scheduling.schedule_draft_edit_requests') IS NOT NULL
      AND to_regclass('cookie_scheduling.schedule_draft_create_requests') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='cookie_scheduling' AND table_name='shift_windows'
          AND column_name='published_revision')
      AND EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema='cookie_scheduling' AND table_name='shift_windows'
          AND column_name='draft_revision')
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='cookie_tenancy' AND table_name='locations'
          AND column_name='time_zone'
      )
      AND EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'cookie_jobs' AND indexname = 'outbox_dedupe'
      )
    THEN 'PASS' ELSE 'FAIL' END;
  ")"

if [[ "$result" != "PASS" ]]; then
  echo "Restore verification failed (schemas, data, migrations or dedupe index)" >&2
  exit 1
fi

verify_booking_fixture cookie_ci_restore_smoke
restored_booking_projection="$(booking_projection cookie_ci_restore_smoke)"
if [[ "$restored_booking_projection" != "$source_booking_projection" ]]; then
  echo "Restored Booking storage projection differs from source" >&2
  exit 1
fi
verify_restored_exclusion cookie_ci_restore_smoke
if [[ "$(booking_projection cookie_ci_restore_smoke)" != "$source_booking_projection" ]]; then
  echo "Restored Booking probe changed durable state" >&2
  exit 1
fi

restored_command_projection="$(pnpm exec tsx scripts/ci-booking-restore-replay.ts replay)"
if [[ "$restored_command_projection" != "$source_command_projection" ]]; then
  echo "Restored real Booking command state differs from source" >&2
  exit 1
fi
echo "PASS: PostgreSQL 16 synthetic backup; migration history, tenant/event, Booking snapshots, receipts, audit and live exclusion verified"
echo "PASS: restored real Create/Reschedule/Cancel receipts replay; revoked role denied; business state unchanged"
