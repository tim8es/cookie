ALTER TABLE cookie_customers.staging_customer_identities
  ALTER COLUMN telegram_link_id DROP NOT NULL;

ALTER TABLE cookie_customers.staging_customer_identities
  ADD COLUMN consent_confirmed_at timestamptz;

UPDATE cookie_customers.staging_customer_identities AS customer
SET consent_confirmed_at=link.consent_confirmed_at
FROM cookie_identity.telegram_identity_links AS link
WHERE customer.telegram_link_id=link.id
  AND customer.tenant_id=link.tenant_id
  AND customer.identity_id=link.identity_id
  AND customer.consent_confirmed_at IS NULL;

ALTER TABLE cookie_customers.staging_customer_identities
  ADD CONSTRAINT staging_customer_identity_consent_source
  CHECK (telegram_link_id IS NOT NULL OR consent_confirmed_at IS NOT NULL);
