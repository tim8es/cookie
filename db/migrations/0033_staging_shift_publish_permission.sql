-- Controlled staging shift publication; no generic schedule.manage grant.
UPDATE cookie_identity.roles AS role
SET permissions = (
  SELECT array_agg(DISTINCT permission ORDER BY permission)
    FROM unnest(role.permissions || ARRAY['staging.shift.publish']::text[]) AS permission
)
WHERE role.base_type='owner'
  AND EXISTS (SELECT 1 FROM cookie_tenancy.organizations org WHERE org.id=role.tenant_id);
