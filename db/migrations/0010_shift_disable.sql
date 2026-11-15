-- F1 INTERNAL protected deactivation of a future staff shift.
-- Never mutate 0001..0009, and never disable a shift silently covering
-- a Confirmed Booking. No public API, real staff/customer data or paid pilot.
CREATE TABLE cookie_scheduling.shift_disable_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  key_sha256 char(64) NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  shift_id uuid NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_identity_id, key_sha256),
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, shift_id)
    REFERENCES cookie_scheduling.shift_windows(tenant_id, id)
    ON DELETE RESTRICT
);

CREATE TABLE cookie_scheduling.shift_disable_audit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  shift_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  previous_active boolean NOT NULL CHECK (previous_active),
  next_active boolean NOT NULL CHECK (NOT next_active),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, shift_id),
  FOREIGN KEY (tenant_id, shift_id)
    REFERENCES cookie_scheduling.shift_windows(tenant_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id)
    ON DELETE RESTRICT
);
CREATE INDEX shift_disable_audit_by_tenant
  ON cookie_scheduling.shift_disable_audit(tenant_id, created_at DESC, id);
