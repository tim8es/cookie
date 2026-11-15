-- F1 INTERNAL: edit future published shift boundaries without orphaning bookings.
-- Existing applied migrations 0001..0012 are immutable.
ALTER TABLE cookie_scheduling.shift_windows
  ADD COLUMN published_revision integer NOT NULL DEFAULT 0
  CONSTRAINT shift_published_revision_nonnegative CHECK (published_revision >= 0);

CREATE TABLE cookie_scheduling.shift_edit_receipts (
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

CREATE TABLE cookie_scheduling.shift_edit_audit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  shift_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  old_start_at timestamptz NOT NULL,
  old_end_at timestamptz NOT NULL,
  new_start_at timestamptz NOT NULL,
  new_end_at timestamptz NOT NULL,
  old_revision integer NOT NULL CHECK (old_revision >= 0),
  new_revision integer NOT NULL CHECK (new_revision > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, shift_id, new_revision),
  FOREIGN KEY (tenant_id, shift_id)
    REFERENCES cookie_scheduling.shift_windows(tenant_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id)
    ON DELETE RESTRICT,
  CONSTRAINT shift_edit_audit_valid CHECK (
    new_start_at < new_end_at
    AND old_start_at < old_end_at
    AND (old_start_at <> new_start_at OR old_end_at <> new_end_at)
    AND new_revision = old_revision + 1
  )
);
CREATE INDEX shift_edit_audit_by_shift
  ON cookie_scheduling.shift_edit_audit(tenant_id, shift_id, new_revision DESC);
