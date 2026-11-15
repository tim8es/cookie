-- F1 INTERNAL BOOKING STORAGE / CONCURRENCY SPIKE — synthetic data only.
-- No public routes, command authorization, safe ScheduleChange or production use.
-- This migration is immutable after application and depends on 0002 + 0004.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS cookie_customers;
CREATE SCHEMA IF NOT EXISTS cookie_booking;

-- FK anchor for an eventual tenant-owned Customer module. No personal data
-- fields or client identity linking are stored yet; never use as an auth proof.
CREATE TABLE cookie_customers.customers (
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

-- One booking is ONE Service, ONE StaffProfile and ONE Location, with immutable
-- service-duration/post-buffer snapshots by convention. A future guarded
-- command must enforce permission, active assignments, price, idempotency and
-- working schedules in its database transaction; FKs alone are insufficient.
CREATE TABLE cookie_booking.bookings (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  service_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN (
    'Confirmed', 'CancelledByClient', 'CancelledByBusiness', 'Completed', 'NoShow'
  )),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  occupied_until timestamptz NOT NULL,
  service_duration_minutes_snapshot integer NOT NULL
    CHECK (service_duration_minutes_snapshot BETWEEN 1 AND 1440),
  post_service_buffer_minutes_snapshot integer NOT NULL
    CHECK (post_service_buffer_minutes_snapshot BETWEEN 0 AND 1440),
  price_kopecks_snapshot bigint NOT NULL
    CHECK (price_kopecks_snapshot BETWEEN 0 AND 999999999999),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id)
    REFERENCES cookie_customers.customers(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, staff_id, location_id, service_id)
    REFERENCES cookie_staff.service_assignments(tenant_id, staff_id, location_id, service_id)
    ON DELETE RESTRICT,
  CONSTRAINT booking_service_interval CHECK (
    end_at = start_at + service_duration_minutes_snapshot * interval '1 minute'
  ),
  CONSTRAINT booking_occupied_interval CHECK (
    occupied_until = end_at + post_service_buffer_minutes_snapshot * interval '1 minute'
  ),
  CONSTRAINT booking_cancellation_timestamp CHECK (
    (status IN ('CancelledByClient', 'CancelledByBusiness'))
    = (cancelled_at IS NOT NULL)
  )
);

-- Critical DB-level backstop: a master cannot have overlapping CONFIRMED
-- occupied intervals in any location of the same tenant. Deliberately NOT
-- keyed by location_id. Half-open '[)' allows precise adjacent boundaries.
-- A cancelled/completed/no-show booking does not reserve future occupancy.
ALTER TABLE cookie_booking.bookings
  ADD CONSTRAINT confirmed_staff_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    staff_id WITH =,
    tstzrange(start_at, occupied_until, '[)') WITH &&
  )
  WHERE (status = 'Confirmed');

CREATE INDEX bookings_tenant_location_start
  ON cookie_booking.bookings (tenant_id, location_id, start_at DESC, id);
CREATE INDEX bookings_tenant_customer_start
  ON cookie_booking.bookings (tenant_id, customer_id, start_at DESC, id);
CREATE INDEX bookings_tenant_staff_start
  ON cookie_booking.bookings (tenant_id, staff_id, start_at DESC, id);

-- Missing intentionally: RLS, verified customer relationship, audit, payment,
-- idempotency receipts, transitions, signed API, atomic price/entitlement
-- rechecks, staff-level scheduling locks and booking-outbox transactions.
-- Those remain mandatory #18/#19/#20/#21/#22 acceptance gates.
