-- Explicit, synthetic controlled-staging grant only. No tariff, trial,
-- premium switch, public route, or implicit grant from Staff capacity.
CREATE TABLE cookie_entitlement.staging_appearance_grants (
  tenant_id uuid PRIMARY KEY REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  id uuid UNIQUE NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  UNIQUE (tenant_id,id)
);

-- Minimal successful publication audit, in the publication transaction.
-- No personal text, image bytes, bearer, pricing plan or public URL.
CREATE TABLE cookie_appearance.publication_audit (
  tenant_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  grant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  published_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,revision),
  FOREIGN KEY (tenant_id,grant_id)
    REFERENCES cookie_entitlement.staging_appearance_grants(tenant_id,id) ON DELETE RESTRICT
);
