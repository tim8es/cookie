-- F1 controlled staging only. This is NOT trial, paid entitlement, billing,
-- a production license or owner-controlled capacity configuration.
CREATE SCHEMA IF NOT EXISTS cookie_entitlement;
CREATE TABLE cookie_entitlement.staging_publication_grants (
  tenant_id uuid PRIMARY KEY REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  id uuid UNIQUE NOT NULL,
  seat_limit integer NOT NULL CHECK (seat_limit > 0),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  UNIQUE (tenant_id,id)
);

-- Never allow a historically published Service to re-enter draft editing.
ALTER TABLE cookie_catalog.services
  ADD COLUMN first_published_at timestamptz;
UPDATE cookie_catalog.services
SET first_published_at=clock_timestamp()
WHERE active OR EXISTS (
  SELECT 1 FROM cookie_booking.bookings AS b
  WHERE b.tenant_id=services.tenant_id AND b.service_id=services.id
);
CREATE FUNCTION cookie_catalog.record_service_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.first_published_at IS NOT NULL THEN
    NEW.first_published_at := OLD.first_published_at;
  ELSIF NEW.active THEN
    NEW.first_published_at := COALESCE(NEW.first_published_at,clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER service_publication_history
BEFORE INSERT OR UPDATE ON cookie_catalog.services
FOR EACH ROW EXECUTE FUNCTION cookie_catalog.record_service_publication();

CREATE TABLE cookie_staff.staging_publication_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  staff_id uuid NOT NULL,
  location_id uuid NOT NULL,
  service_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,actor_identity_id,idempotency_key),
  FOREIGN KEY (tenant_id,staff_id,location_id,service_id)
    REFERENCES cookie_staff.service_assignments(tenant_id,staff_id,location_id,service_id),
  FOREIGN KEY (tenant_id,grant_id)
    REFERENCES cookie_entitlement.staging_publication_grants(tenant_id,id)
);
CREATE INDEX staff_bookable_seat_count
 ON cookie_staff.staff_profiles(tenant_id,id) WHERE active AND bookable;

UPDATE cookie_identity.roles AS role
SET permissions=(
  SELECT array_agg(DISTINCT permission ORDER BY permission)
  FROM unnest(role.permissions || ARRAY['staging.entitlement.read','staging.staff.publish']::text[]) AS permission
)
WHERE role.base_type='owner';
