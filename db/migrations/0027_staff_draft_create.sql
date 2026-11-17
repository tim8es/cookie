-- F1: real owner-controlled draft Staff and initial location/service pairing.
-- No scheduling publication, client booking activation or paid-seat logic here.
ALTER TABLE cookie_staff.staff_profiles
  ADD COLUMN position_title text NOT NULL DEFAULT ''
  CONSTRAINT staff_position_title_length CHECK (
    length(position_title) <= 80
  );

CREATE TABLE cookie_staff.staff_create_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_identity_id, idempotency_key),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES cookie_staff.staff_profiles(tenant_id, id) ON DELETE RESTRICT
);

-- Extend only actual Owner roles of existing workspaces. Each request still
-- requires active membership, trusted bearer and organization-scope role.
UPDATE cookie_identity.roles AS role
SET permissions = (
  SELECT array_agg(DISTINCT permission ORDER BY permission)
    FROM unnest(role.permissions || ARRAY[
      'staff.profile.read', 'staff.profile.create'
    ]::text[]) AS permission
)
WHERE role.base_type = 'owner'
  AND EXISTS (
    SELECT 1 FROM cookie_tenancy.organizations AS org
     WHERE org.id = role.tenant_id
  );
