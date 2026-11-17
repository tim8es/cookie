-- Synthetic staging only. No personal data or automatic enrollment.
-- One immutable tenant-scoped Customer <-> Identity association. Revoke the
-- channel link/membership to deny access; reassignment is not supported.
CREATE TABLE cookie_customers.staging_customer_identities (
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  telegram_link_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, customer_id),
  UNIQUE (tenant_id, identity_id),
  FOREIGN KEY (tenant_id,customer_id) REFERENCES cookie_customers.customers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,identity_id) REFERENCES cookie_identity.memberships(tenant_id,identity_id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,identity_id,telegram_link_id) REFERENCES cookie_identity.telegram_identity_links(tenant_id,identity_id,id) ON DELETE RESTRICT
);
