-- F1 INTERNAL future inactive shift drafts with optimistic revision.
-- Never edit applied 0001..0011 migrations.
ALTER TABLE cookie_scheduling.shift_windows
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 0
  CONSTRAINT shift_draft_revision_nonnegative CHECK (draft_revision >= 0);

-- A successful (tenant, verified actor, operation, idempotency key) receipt
-- is immutable, contains no raw key and survives later draft revisions.
CREATE TABLE cookie_scheduling.shift_draft_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create', 'edit')),
  key_sha256 char(64) NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  shift_id uuid NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_identity_id, operation, key_sha256),
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, shift_id)
    REFERENCES cookie_scheduling.shift_windows(tenant_id, id)
    ON DELETE RESTRICT
);

-- Actor/interval lineage without names, customer contacts or freeform notes.
-- UNIQUE revision helps detect accidental duplicate writes. A create audit
-- is required for edits; pre-existing ambiguous legacy shifts fail closed.
CREATE TABLE cookie_scheduling.shift_draft_audit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  shift_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  operation text NOT NULL CHECK (operation IN ('create', 'edit')),
  old_start_at timestamptz,
  old_end_at timestamptz,
  new_start_at timestamptz NOT NULL,
  new_end_at timestamptz NOT NULL,
  old_revision integer,
  new_revision integer NOT NULL CHECK (new_revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, shift_id, new_revision),
  FOREIGN KEY (tenant_id, shift_id)
    REFERENCES cookie_scheduling.shift_windows(tenant_id, id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id)
    ON DELETE RESTRICT,
  CONSTRAINT shift_draft_audit_valid CHECK (
    new_start_at < new_end_at AND (
      (operation = 'create' AND old_start_at IS NULL
        AND old_end_at IS NULL AND old_revision IS NULL AND new_revision = 0)
      OR
      (operation = 'edit' AND old_start_at IS NOT NULL
        AND old_end_at IS NOT NULL AND old_revision >= 0
        AND new_revision = old_revision + 1
        AND (new_start_at <> old_start_at OR new_end_at <> old_end_at))
    )
  )
);
CREATE INDEX shift_draft_audit_by_shift
  ON cookie_scheduling.shift_draft_audit (tenant_id, shift_id, new_revision DESC);
