-- Owner-only staging schedule publication and provisional availability inspection.
UPDATE cookie_identity.roles AS role
SET permissions=(
  SELECT array_agg(DISTINCT permission ORDER BY permission)
  FROM unnest(role.permissions || ARRAY['staging.shift.publish','staging.availability.read']::text[]) AS permission
)
WHERE role.base_type='owner';
