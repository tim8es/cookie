-- Extend only existing dedicated synthetic Client roles, never arbitrary or revoked roles.
-- A deliberately removed context/offers permission is not restored by migration.
UPDATE cookie_identity.roles r
SET permissions=array_append(r.permissions,'staging.customer.booking.cancel')
WHERE r.base_type='client' AND r.active AND r.permissions=ARRAY['staging.customer.context.read','staging.customer.offers.read','staging.customer.booking.create','staging.customer.bookings.read']::text[]
  AND EXISTS (
    SELECT 1 FROM cookie_identity.role_assignments a
    JOIN cookie_customers.staging_customer_identities c ON c.tenant_id=a.tenant_id AND c.identity_id=a.identity_id
    WHERE a.tenant_id=r.tenant_id AND a.role_id=r.id AND a.active AND a.location_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM cookie_identity.role_assignments a
    WHERE a.tenant_id=r.tenant_id AND a.role_id=r.id
      AND (a.location_id IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM cookie_customers.staging_customer_identities c
        WHERE c.tenant_id=a.tenant_id AND c.identity_id=a.identity_id))
  );

-- Preserve all previous business-cancellation audit rows and admit client terminal state.
ALTER TABLE cookie_booking.booking_state_audit DROP CONSTRAINT booking_state_audit_next_status_check;
ALTER TABLE cookie_booking.booking_state_audit ADD CONSTRAINT booking_state_audit_next_status_check CHECK (next_status IN ('CancelledByBusiness','CancelledByClient'));
