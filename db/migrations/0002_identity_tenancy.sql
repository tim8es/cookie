-- F1 internal identity/tenancy baseline. No real PII or production access.
-- A migration is immutable once applied. Tenant relationships use composite FKs.
CREATE SCHEMA IF NOT EXISTS cookie_tenancy;
CREATE SCHEMA IF NOT EXISTS cookie_identity;

CREATE TABLE cookie_identity.identities (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cookie_tenancy.organizations (
  id uuid PRIMARY KEY,
  owner_identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cookie_tenancy.locations (
  id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE cookie_identity.memberships (
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, identity_id)
);
CREATE INDEX memberships_by_identity
  ON cookie_identity.memberships (identity_id, tenant_id);

CREATE TABLE cookie_identity.roles (
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  base_type text NOT NULL CHECK (base_type IN ('client', 'staff', 'admin', 'owner')),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 100),
  permissions text[] NOT NULL DEFAULT ARRAY[]::text[],
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id)
);

-- Each assignment has either organization scope (location_id IS NULL)
-- or exactly one location. Multi-location scope is represented by several
-- assignments. This avoids ambiguous JSON and enforces location tenant scope.
CREATE TABLE cookie_identity.role_assignments (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  identity_id uuid NOT NULL,
  role_id uuid NOT NULL,
  location_id uuid,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, identity_id)
    REFERENCES cookie_identity.memberships(tenant_id, identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, role_id)
    REFERENCES cookie_identity.roles(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, location_id)
    REFERENCES cookie_tenancy.locations(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE NULLS NOT DISTINCT (tenant_id, identity_id, role_id, location_id)
);
CREATE INDEX role_assignments_by_member
  ON cookie_identity.role_assignments (tenant_id, identity_id);

-- Minimal security audit: no names, phone numbers, tokens, note text or payload.
-- A denied attempt at a foreign branch is logged as attempted UUID only,
-- without a branch FK (because the branch may not belong to this tenant).
CREATE TABLE cookie_identity.authorization_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  actor_identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  location_id uuid,
  permission text NOT NULL CHECK (length(permission) BETWEEN 1 AND 128),
  allowed boolean NOT NULL,
  reason text NOT NULL CHECK (reason IN (
    'granted', 'invalid-context', 'foreign-tenant', 'inactive-membership',
    'invalid-role-config', 'owner-required', 'permission-denied'
  )),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authorization_audit_by_tenant_time
  ON cookie_identity.authorization_audit (tenant_id, created_at DESC, id DESC);
