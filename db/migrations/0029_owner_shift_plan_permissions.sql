-- F1: owner-only draft planning, independent of publication or approval.
UPDATE cookie_identity.roles AS role
SET permissions = (
  SELECT array_agg(DISTINCT permission ORDER BY permission)
    FROM unnest(role.permissions || ARRAY[
      'schedule.shift.plan.read','schedule.shift.plan.create'
    ]::text[]) AS permission
)
WHERE role.base_type = 'owner'
  AND EXISTS (
    SELECT 1 FROM cookie_tenancy.organizations AS org
     WHERE org.id = role.tenant_id
  );
