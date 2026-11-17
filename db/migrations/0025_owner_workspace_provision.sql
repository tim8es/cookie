-- Trusted owner workspace provisioning receipts. No public registration or AuthN.
-- Supports replay after uncertain COMMIT without creating another Organization.
CREATE TABLE cookie_tenancy.owner_setup_receipts (
  owner_identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 128 AND
    idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  location_id uuid NOT NULL,
  role_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_identity_id, idempotency_key),
  FOREIGN KEY (tenant_id, owner_identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES cookie_tenancy.locations(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, role_id)
    REFERENCES cookie_identity.roles(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, assignment_id)
    REFERENCES cookie_identity.role_assignments(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX owner_setup_receipts_by_tenant
  ON cookie_tenancy.owner_setup_receipts(tenant_id, created_at DESC);
