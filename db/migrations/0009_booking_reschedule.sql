-- F1 internal time-only reschedule after migration 0008 business cancellation.
-- DEC-070: unchanged Booking ID, Staff, Location, Service, price/promos.
-- Extend scoped command receipts without rewriting applied migrations.
ALTER TABLE cookie_booking.command_receipts
  DROP CONSTRAINT command_receipts_operation_check;
ALTER TABLE cookie_booking.command_receipts
  ADD CONSTRAINT command_receipts_operation_check
  CHECK (operation IN ('booking.create', 'booking.cancel', 'booking.reschedule'));

-- Each successful time change is auditable; subsequent reschedules must NOT
-- overwrite previous old/new timestamps or expose customer contact details.
CREATE TABLE cookie_booking.time_change_audit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  booking_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  old_start_at timestamptz NOT NULL,
  new_start_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id)
    REFERENCES cookie_booking.bookings(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
  CONSTRAINT time_change_nonempty CHECK (new_start_at <> old_start_at)
);
CREATE INDEX time_change_audit_by_booking
  ON cookie_booking.time_change_audit (tenant_id, booking_id, created_at DESC);
