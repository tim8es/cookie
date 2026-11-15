#!/usr/bin/env bash
set -euo pipefail

# Synthetic-only CI restore proof. Never point this script at a live database.
EXPECTED_URL="postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci"
if [[ "${CI:-}" != "true" || "${TEST_DATABASE_URL:-}" != "$EXPECTED_URL" ]]; then
  echo "Refusing restore smoke outside the exact isolated CI database" >&2
  exit 2
fi

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
      (SELECT count(*) FROM public.cookie_schema_migrations) = 20
      AND EXISTS (
        SELECT 1 FROM cookie_jobs.outbox_events AS event
        JOIN cookie_tenancy.organizations AS org ON org.id = event.tenant_id
        WHERE event.id = 'e3333333-3333-4333-8333-333333333333'
          AND event.status = 'pending'
          AND event.payload = '{\"synthetic\":true}'::jsonb
          AND org.display_name = 'Synthetic restore smoke'
      )
      AND to_regclass('cookie_customers.customers') IS NOT NULL
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

echo "PASS: PostgreSQL 16 synthetic backup restored into separate database; migration history, tenant/event records and dedupe index verified"
