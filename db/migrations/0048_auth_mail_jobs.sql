-- Global pre-tenant auth queue. Never store raw email or proof bearer.
CREATE TABLE cookie_identity.auth_mail_jobs (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('registration','password-recovery','email-link')),
  identity_id uuid REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  sealed_recipient bytea,
  status text NOT NULL CHECK (status IN ('pending','leased','dispatching','submitted','skipped','unknown','expired')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  lease_token uuid,
  lease_until timestamptz,
  CHECK ((status IN ('pending','leased')) = (sealed_recipient IS NOT NULL)),
  CHECK ((purpose='email-link') = (identity_id IS NOT NULL)),
  CHECK ((status IN ('leased','dispatching')) = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (sealed_recipient IS NULL OR octet_length(sealed_recipient) BETWEEN 29 AND 282)
);
CREATE INDEX auth_mail_jobs_ready
  ON cookie_identity.auth_mail_jobs (created_at, id)
  WHERE status IN ('pending','leased');
CREATE INDEX auth_mail_jobs_expiry
  ON cookie_identity.auth_mail_jobs (expires_at, id);
CREATE INDEX auth_mail_jobs_lease
  ON cookie_identity.auth_mail_jobs (lease_until, id)
  WHERE status IN ('leased','dispatching');
