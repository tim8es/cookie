-- Draft-only service editing and immutable response receipts.
-- Existing create receipts had no snapshot; backfill from current stored rows.
-- This branch is F1 staging only; prior external SQL edits are not reconstructible.
ALTER TABLE cookie_catalog.services
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 0 CHECK (draft_revision >= 0);

ALTER TABLE cookie_catalog.service_create_receipts
  ADD COLUMN result_service jsonb;

UPDATE cookie_catalog.service_create_receipts AS receipt
SET result_service = jsonb_build_object(
  'id', service.id::text,
  'displayName', service.display_name,
  'durationMinutes', service.duration_minutes,
  'basePriceKopecks', service.base_price_kopecks,
  'active', service.active,
  'createdAt', to_char(service.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'revision', service.draft_revision
)
FROM cookie_catalog.services AS service
WHERE receipt.tenant_id=service.tenant_id AND receipt.service_id=service.id;

ALTER TABLE cookie_catalog.service_create_receipts
  ALTER COLUMN result_service SET NOT NULL,
  ADD CHECK (jsonb_typeof(result_service)='object');

CREATE TABLE cookie_catalog.service_edit_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  service_id uuid NOT NULL,
  result_service jsonb NOT NULL CHECK (jsonb_typeof(result_service)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, actor_identity_id, idempotency_key),
  FOREIGN KEY (tenant_id, service_id)
    REFERENCES cookie_catalog.services(tenant_id,id) ON DELETE RESTRICT
);

CREATE INDEX service_create_receipts_by_service
  ON cookie_catalog.service_create_receipts (tenant_id,service_id);
CREATE INDEX bookings_tenant_service
  ON cookie_booking.bookings (tenant_id,service_id);

UPDATE cookie_identity.roles AS role
SET permissions=(
  SELECT array_agg(DISTINCT permission ORDER BY permission)
  FROM unnest(role.permissions || ARRAY['catalog.service.edit-draft']::text[]) AS permission
)
WHERE role.base_type='owner';
