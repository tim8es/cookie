-- Synthetic-only Telegram provider provenance. No runtime issuer allowed.
ALTER TABLE cookie_identity.global_telegram_identities
  ADD CONSTRAINT global_telegram_exact_identity
  UNIQUE (telegram_user_hmac_sha256,identity_id);
ALTER TABLE cookie_identity.refresh_session_families
  ADD COLUMN telegram_provider_fingerprint bytea,
  ADD CONSTRAINT refresh_telegram_source_scope CHECK (
    telegram_provider_fingerprint IS NULL OR (
      octet_length(telegram_provider_fingerprint)=32
      AND issuer='cookie-refresh-candidate' AND audience='synthetic-test'
    )
  ),
  ADD CONSTRAINT refresh_exact_telegram_source
    FOREIGN KEY (telegram_provider_fingerprint,identity_id)
    REFERENCES cookie_identity.global_telegram_identities(telegram_user_hmac_sha256,identity_id)
    ON DELETE RESTRICT;
CREATE INDEX refresh_families_telegram_source
  ON cookie_identity.refresh_session_families(telegram_provider_fingerprint,identity_id)
  WHERE telegram_provider_fingerprint IS NOT NULL;

-- Existing migrated-source trigger updates the global mapping first.
-- Lock order for refresh and source revocation is mapping -> family -> access.
CREATE FUNCTION cookie_identity.revoke_telegram_refresh_source()
RETURNS trigger LANGUAGE plpgsql AS $source$
BEGIN
  UPDATE cookie_identity.refresh_session_families
     SET revoked_at=clock_timestamp()
   WHERE telegram_provider_fingerprint=OLD.telegram_user_hmac_sha256
     AND identity_id=OLD.identity_id AND revoked_at IS NULL;
  RETURN NEW;
END;
$source$;
CREATE TRIGGER revoke_telegram_refresh_source_change
AFTER UPDATE ON cookie_identity.global_telegram_identities
FOR EACH ROW WHEN (
  OLD.legacy_revoked_at IS DISTINCT FROM NEW.legacy_revoked_at
  OR OLD.legacy_tenant_id IS DISTINCT FROM NEW.legacy_tenant_id
  OR OLD.legacy_link_id IS DISTINCT FROM NEW.legacy_link_id
  OR OLD.migration_request_id IS DISTINCT FROM NEW.migration_request_id
)
EXECUTE FUNCTION cookie_identity.revoke_telegram_refresh_source();
