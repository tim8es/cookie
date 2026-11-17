-- Explicit owner-only permission for controlled staging provisional slots.
UPDATE cookie_identity.roles AS role
SET permissions=(
  SELECT array_agg(DISTINCT permission ORDER BY permission)
  FROM unnest(role.permissions || ARRAY['staging.availability.read']::text[]) AS permission
)
WHERE role.base_type='owner';
