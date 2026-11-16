-- F1: guarded tenant-scoped draft Service creation and deterministic replay.
-- Existing catalog/service price schema stays unchanged; all records default
-- to inactive/non-bookable. Never backfill customer data or publish services.
CREATE TABLE cookie_catalog.service_create_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  service_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_identity_id, idempotency_key),
  FOREIGN KEY (tenant_id, service_id)
    REFERENCES cookie_catalog.services(tenant_id, id) ON DELETE RESTRICT
);

-- Bootstrap owners created before this migration require the new Catalog
-- capability as well. The existing signed-in owner identity, active membership,
-- current role assignment and role state must still be checked on EVERY call.
-- Only real owner-role rows get the additions, not broad organization readers.
UPDATE cookie_identity.roles AS role
SET permissions = (
  SELECT array_agg(DISTINCT permission ORDER BY permission)
  FROM unnest(role.permissions || ARRAY[
    'catalog.service.read', 'catalog.service.create'
  ]::text[]) AS permission
)
WHERE role.base_type = 'owner'
  AND EXISTS (
    SELECT 1 FROM cookie_tenancy.organizations AS org
    WHERE org.id = role.tenant_id
  );
