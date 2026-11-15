-- F1 INTERNAL: approval requests for editing future inactive draft windows.
-- Strictly additive; migrations 0001..0019 are immutable.
CREATE TABLE cookie_scheduling.schedule_draft_edit_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  shift_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  requester_identity_id uuid NOT NULL,
  key_sha256 char(64) NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  policy_revision integer NOT NULL CHECK (policy_revision >= 0),
  expected_draft_revision integer NOT NULL CHECK (expected_draft_revision >= 0),
  expected_start_at timestamptz NOT NULL,
  expected_end_at timestamptz NOT NULL,
  new_start_at timestamptz NOT NULL,
  new_end_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','applied','rejected')),
  reviewer_identity_id uuid,
  decision_key_sha256 char(64)
    CHECK (decision_key_sha256 IS NULL OR decision_key_sha256 ~ '^[0-9a-f]{64}$'),
  applied_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,requester_identity_id,key_sha256),
  FOREIGN KEY (tenant_id,shift_id)
    REFERENCES cookie_scheduling.shift_windows(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,staff_id,location_id)
    REFERENCES cookie_staff.location_assignments(tenant_id,staff_id,location_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,requester_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id,identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,reviewer_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id,identity_id) ON DELETE RESTRICT,
  CONSTRAINT schedule_draft_edit_review_complete CHECK (
    (status='pending' AND reviewer_identity_id IS NULL
      AND decision_key_sha256 IS NULL AND applied_receipt IS NULL
      AND decided_at IS NULL)
    OR
    (status='rejected' AND reviewer_identity_id IS NOT NULL
      AND decision_key_sha256 IS NOT NULL AND applied_receipt IS NULL
      AND decided_at IS NOT NULL)
    OR
    (status='applied' AND reviewer_identity_id IS NOT NULL
      AND decision_key_sha256 IS NOT NULL
      AND jsonb_typeof(applied_receipt)='object'
      AND decided_at IS NOT NULL)
  ),
  CONSTRAINT schedule_draft_edit_request_windows CHECK (
    expected_end_at > expected_start_at
    AND expected_end_at <= expected_start_at + interval '48 hours'
    AND new_end_at > new_start_at
    AND new_end_at <= new_start_at + interval '48 hours'
    AND (new_start_at<>expected_start_at OR new_end_at<>expected_end_at)
  )
);
CREATE INDEX schedule_draft_edit_pending_by_tenant
  ON cookie_scheduling.schedule_draft_edit_requests(tenant_id,created_at,id)
  WHERE status='pending';
