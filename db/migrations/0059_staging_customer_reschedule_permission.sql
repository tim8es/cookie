-- Only default Client roles whose staging Customer association is still live.
-- A custom or intentionally reduced capability set is NOT auto-upgraded.
UPDATE cookie_identity.roles r
SET permissions=array_append(r.permissions,'staging.customer.booking.reschedule')
WHERE r.base_type='client' AND r.active AND r.display_name IN ('Client','Staging Client')
  AND r.permissions=ARRAY['staging.customer.context.read','staging.customer.offers.read','staging.customer.booking.create','staging.customer.bookings.read','staging.customer.booking.cancel']::text[]
  AND EXISTS (
    SELECT 1 FROM cookie_identity.role_assignments a
    JOIN cookie_customers.staging_customer_identities c
      ON c.tenant_id=a.tenant_id AND c.identity_id=a.identity_id
    WHERE a.tenant_id=r.tenant_id AND a.role_id=r.id AND a.active AND a.location_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM cookie_identity.role_assignments a
    WHERE a.tenant_id=r.tenant_id AND a.role_id=r.id
      AND (a.location_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM cookie_customers.staging_customer_identities c
        WHERE c.tenant_id=a.tenant_id AND c.identity_id=a.identity_id
      ))
  );
