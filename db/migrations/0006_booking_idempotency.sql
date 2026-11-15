-- F1 internal CreateBooking idempotency; no public route or real customer data.
-- One immutable command result per trusted tenant/actor/operation/key digest.
-- No raw idempotency tokens, contact details or message content are stored.
CREATE TABLE cookie_booking.command_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation = 'booking.create'),
  key_sha256 char(64) NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  booking_id uuid NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_identity_id, operation, key_sha256),
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, booking_id)
    REFERENCES cookie_booking.bookings(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX command_receipts_by_booking
  ON cookie_booking.command_receipts (tenant_id, booking_id);
-- This table stores successful committed commands only. Failed attempts must
-- roll back the entire transaction, including Booking, outbox and audit.
