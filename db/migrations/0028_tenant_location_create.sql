-- F1: durable owner-created tenant branches. These records do not publish booking.
-- Historical location table remains authoritative; no Customer/Staff/Booking changes.
CREATE TABLE cookie_tenancy.location_create_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL,
  idempotency_key text NOT NULL
    CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  location_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_identity_id, idempotency_key),
  FOREIGN KEY (tenant_id, actor_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES cookie_tenancy.locations(tenant_id, id) ON DELETE RESTRICT
);

-- Grant only real owner-type roles; not arbitrary staff/admin memberships.
UPDATE cookie_identity.roles AS role
SET permissions = (
  SELECT array_agg(DISTINCT permission ORDER BY permission)
  FROM unnest(role.permissions || ARRAY[
    'location.read', 'location.create'
  ]::text[]) AS permission
)
WHERE role.base_type='owner'
  AND EXISTS (
    SELECT 1 FROM cookie_tenancy.organizations AS org
    WHERE org.id=role.tenant_id
  );
