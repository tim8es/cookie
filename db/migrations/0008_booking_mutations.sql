-- F1 INTERNAL business-operator Cancel/Reschedule commands only.
-- Only successful mutations have durable receipts/audit. No customer/guest API.
-- Existing applied migrations are immutable; operation list extends 0007.
ALTER TABLE cookie_booking.command_receipts
  DROP CONSTRAINT command_receipts_operation_check;
ALTER TABLE cookie_booking.command_receipts
  ADD CONSTRAINT command_receipts_operation_check
  CHECK (operation IN ('booking.create', 'booking.cancel', 'booking.reschedule'));

-- Minimal business mutation audit: no customer contact info, note text,
-- promo tokens, request idempotency tokens or externally supplied narratives.
CREATE TABLE cookie_booking.mutation_audit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  booking_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  operation text NOT NULL CHECK (operation IN ('booking.cancel', 'booking.reschedule')),
  old_start_at timestamptz NOT NULL,
  new_start_at timestamptz,
  old_status text NOT NULL CHECK (old_status = 'Confirmed'),
  new_status text NOT NULL CHECK (new_status IN ('Confirmed', 'CancelledByBusiness')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id)
    REFERENCES cookie_booking.bookings(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
  CONSTRAINT mutation_audit_transition CHECK (
    (operation = 'booking.cancel' AND new_status = 'CancelledByBusiness'
      AND new_start_at IS NULL)
    OR
    (operation = 'booking.reschedule' AND new_status = 'Confirmed'
      AND new_start_at IS NOT NULL AND new_start_at <> old_start_at)
  )
);
CREATE INDEX mutation_audit_by_booking
  ON cookie_booking.mutation_audit (tenant_id, booking_id, created_at DESC);
