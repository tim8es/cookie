-- Candidate: retain the exact legacy authority and never resurrect it.
ALTER TABLE cookie_identity.global_telegram_identities
  ADD COLUMN legacy_tenant_id uuid,
  ADD COLUMN legacy_link_id uuid,
  ADD COLUMN migration_request_id uuid UNIQUE
    REFERENCES cookie_identity.legacy_telegram_migration_preparations(request_id) ON DELETE RESTRICT,
  ADD COLUMN legacy_revoked_at timestamptz,
  ADD CONSTRAINT global_telegram_legacy_source
    FOREIGN KEY (legacy_tenant_id, identity_id, legacy_link_id)
    REFERENCES cookie_identity.telegram_identity_links(tenant_id, identity_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT global_telegram_legacy_source_complete
    CHECK (
      (legacy_tenant_id IS NULL AND legacy_link_id IS NULL
       AND migration_request_id IS NULL AND legacy_revoked_at IS NULL)
      OR
      (legacy_tenant_id IS NOT NULL AND legacy_link_id IS NOT NULL
       AND migration_request_id IS NOT NULL)
    );
CREATE INDEX global_telegram_legacy_source_idx
  ON cookie_identity.global_telegram_identities(legacy_tenant_id,identity_id,legacy_link_id)
  WHERE legacy_link_id IS NOT NULL;

-- Revoking the original authority permanently closes the migrated Telegram
-- provider and revokes its global Telegram sessions in the same transaction.
-- Email-origin sessions are deliberately not part of that authority.
CREATE FUNCTION cookie_identity.disable_migrated_telegram_source()
RETURNS trigger LANGUAGE plpgsql AS $migration$
BEGIN
  WITH disabled AS (
    UPDATE cookie_identity.global_telegram_identities
       SET legacy_revoked_at=clock_timestamp()
     WHERE legacy_tenant_id=NEW.tenant_id AND identity_id=NEW.identity_id
       AND legacy_revoked_at IS NULL
       AND legacy_link_id IS NOT NULL
       AND (TG_TABLE_NAME='memberships' OR legacy_link_id::text=to_jsonb(NEW)->>'id')
     RETURNING identity_id
  ), revoked AS (
    UPDATE cookie_identity.identity_sessions s
       SET revoked_at=clock_timestamp()
      FROM disabled d
     WHERE s.identity_id=d.identity_id AND s.issuer='cookie-telegram'
       AND s.audience='cookie-web' AND s.revoked_at IS NULL
     RETURNING s.identity_id
  )
  INSERT INTO cookie_identity.auth_security_events(event_type,identity_id)
  SELECT 'identity_session_revoked', identity_id FROM revoked;
  RETURN NEW;
END;
$migration$;
CREATE TRIGGER disable_migrated_telegram_on_link_change
AFTER UPDATE ON cookie_identity.telegram_identity_links
FOR EACH ROW WHEN (
  NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS DISTINCT FROM NEW.revoked_at
  OR OLD.telegram_user_hmac_sha256 IS DISTINCT FROM NEW.telegram_user_hmac_sha256
  OR OLD.proof_verified_at IS DISTINCT FROM NEW.proof_verified_at
  OR OLD.consent_confirmed_at IS DISTINCT FROM NEW.consent_confirmed_at
)
EXECUTE FUNCTION cookie_identity.disable_migrated_telegram_source();
CREATE TRIGGER disable_migrated_telegram_on_membership_disable
AFTER UPDATE OF active ON cookie_identity.memberships
FOR EACH ROW WHEN (OLD.active AND NOT NEW.active)
EXECUTE FUNCTION cookie_identity.disable_migrated_telegram_source();
