-- F1 INTERNAL: inert requests for creating future ShiftWindow drafts.
-- No shift_id on submission: the ShiftWindow exists only after owner approval.
-- Additive migration; scripts 0001..0020 are immutable.
CREATE TABLE cookie_scheduling.schedule_draft_create_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  requester_identity_id uuid NOT NULL,
  key_sha256 char(64) NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  policy_revision integer NOT NULL CHECK (policy_revision >= 0),
  proposed_start_at timestamptz NOT NULL,
  proposed_end_at timestamptz NOT NULL,
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
  FOREIGN KEY (tenant_id,staff_id,location_id)
    REFERENCES cookie_staff.location_assignments(tenant_id,staff_id,location_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,requester_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id,identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,reviewer_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id,identity_id) ON DELETE RESTRICT,
  CONSTRAINT schedule_draft_create_window CHECK (
    proposed_end_at > proposed_start_at
    AND proposed_end_at <= proposed_start_at + interval '48 hours'
  ),
  CONSTRAINT schedule_draft_create_review_complete CHECK (
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
  )
);
CREATE INDEX schedule_draft_create_pending_by_tenant
  ON cookie_scheduling.schedule_draft_create_requests(tenant_id,created_at,id)
  WHERE status='pending';
