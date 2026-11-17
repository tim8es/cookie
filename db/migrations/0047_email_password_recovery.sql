-- Changing a password invalidates every challenge for its old generation.
ALTER TABLE cookie_identity.email_credentials
  ADD COLUMN credential_version uuid NOT NULL DEFAULT gen_random_uuid();

-- Keep the generation invariant even for later password/credential writers.
CREATE FUNCTION cookie_identity.rotate_email_credential_version()
RETURNS trigger LANGUAGE plpgsql AS $recovery$
BEGIN
  NEW.credential_version := gen_random_uuid();
  RETURN NEW;
END;
$recovery$;
CREATE TRIGGER rotate_email_credential_version
BEFORE UPDATE OF password_hash, identity_id, email_hmac_sha256
ON cookie_identity.email_credentials
FOR EACH ROW WHEN (
  OLD.password_hash IS DISTINCT FROM NEW.password_hash OR
  OLD.identity_id IS DISTINCT FROM NEW.identity_id OR
  OLD.email_hmac_sha256 IS DISTINCT FROM NEW.email_hmac_sha256
)
EXECUTE FUNCTION cookie_identity.rotate_email_credential_version();

CREATE TABLE cookie_identity.email_password_recovery_challenges (
  token_sha256 bytea PRIMARY KEY CHECK (octet_length(token_sha256) = 32),
  email_hmac_sha256 bytea NOT NULL
    REFERENCES cookie_identity.email_credentials(email_hmac_sha256) ON DELETE CASCADE,
  credential_version uuid NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX email_password_recovery_expiry
  ON cookie_identity.email_password_recovery_challenges (expires_at);
CREATE INDEX email_password_recovery_account
  ON cookie_identity.email_password_recovery_challenges (email_hmac_sha256);
