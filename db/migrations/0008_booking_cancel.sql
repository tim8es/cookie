-- F1 internal cancellation only. One operation receipt and mutation audit
-- commit atomically with Booking status and Outbox, on synthetic fixtures.
-- The existing 0007 migration is immutable and must never be edited.
ALTER TABLE cookie_booking.command_receipts
  DROP CONSTRAINT command_receipts_operation_check;
ALTER TABLE cookie_booking.command_receipts
  ADD CONSTRAINT command_receipts_operation_check
  CHECK (operation IN ('booking.create', 'booking.cancel'));

CREATE TABLE cookie_booking.booking_state_audit (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  command text NOT NULL CHECK (command = 'booking.cancel'),
  previous_status text NOT NULL CHECK (previous_status = 'Confirmed'),
  next_status text NOT NULL CHECK (next_status = 'CancelledByBusiness'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id)
    REFERENCES cookie_booking.bookings(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, booking_id, command)
);
CREATE INDEX booking_state_audit_by_booking
  ON cookie_booking.booking_state_audit (tenant_id, booking_id, created_at);
