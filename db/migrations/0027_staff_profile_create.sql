-- F1: tenant-scoped StaffProfile drafts, no staff login, publishing or bookings.
-- Existing profiles are supported; nullable title is descriptive, never a role.
ALTER TABLE cookie_staff.staff_profiles
  ADD COLUMN position_title text
    CONSTRAINT staff_position_title_length
      CHECK (
        position_title IS NULL OR
        length(btrim(position_title)) BETWEEN 1 AND 100
      );

CREATE TABLE cookie_staff.profile_create_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL
    REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  staff_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_identity_id, idempotency_key),
  FOREIGN KEY (tenant_id, staff_id)
    REFERENCES cookie_staff.staff_profiles(tenant_id, id) ON DELETE RESTRICT
);

-- Existing owners need Staff draft permissions without changing delegated roles.
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
