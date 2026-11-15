-- F1 internal organization-wide policy for published-shift time edits.
-- Additive migration only; do not modify 0001..0013.
CREATE TABLE cookie_scheduling.schedule_edit_policies (
  tenant_id uuid PRIMARY KEY REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('direct', 'approval')),
  revision integer NOT NULL CHECK (revision > 0),
  changed_by uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, changed_by)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT
);
CREATE TABLE cookie_scheduling.schedule_edit_policy_audit (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  old_mode text NOT NULL CHECK (old_mode IN ('direct', 'approval')),
  new_mode text NOT NULL CHECK (new_mode IN ('direct', 'approval')),
  old_revision integer NOT NULL CHECK (old_revision >= 0),
  new_revision integer NOT NULL CHECK (new_revision = old_revision + 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT
);

-- A request is an immutable proposed interval + revision; only the review
-- status/decision fields mutate. Reviewed payload is never trusted as a
-- booking entitlement. Actual edit revalidates every invariant at commit.
CREATE TABLE cookie_scheduling.schedule_edit_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  shift_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  requester_identity_id uuid NOT NULL,
  key_sha256 char(64) NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  policy_revision integer NOT NULL CHECK (policy_revision >= 0),
  expected_published_revision integer NOT NULL CHECK (expected_published_revision >= 0),
  new_start_at timestamptz NOT NULL,
  new_end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected')),
  reviewer_identity_id uuid,
  decision_key_sha256 char(64) CHECK (decision_key_sha256 IS NULL OR decision_key_sha256 ~ '^[0-9a-f]{64}$'),
  applied_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, requester_identity_id, key_sha256),
  FOREIGN KEY (tenant_id, shift_id)
    REFERENCES cookie_scheduling.shift_windows(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, staff_id, location_id)
    REFERENCES cookie_staff.location_assignments(tenant_id, staff_id, location_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, requester_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, reviewer_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
  CHECK (new_end_at > new_start_at AND new_end_at <= new_start_at + interval '48 hours'),
  CONSTRAINT schedule_edit_request_review_complete CHECK (
    (status = 'pending' AND reviewer_identity_id IS NULL
      AND decision_key_sha256 IS NULL AND applied_receipt IS NULL
      AND decided_at IS NULL)
    OR
    (status = 'rejected' AND reviewer_identity_id IS NOT NULL
      AND decision_key_sha256 IS NOT NULL AND applied_receipt IS NULL
      AND decided_at IS NOT NULL)
    OR
    (status = 'applied' AND reviewer_identity_id IS NOT NULL
      AND decision_key_sha256 IS NOT NULL
      AND jsonb_typeof(applied_receipt) = 'object'
      AND decided_at IS NOT NULL)
  )
);
CREATE INDEX schedule_edit_pending_by_tenant
  ON cookie_scheduling.schedule_edit_requests(tenant_id, created_at, id)
  WHERE status = 'pending';
