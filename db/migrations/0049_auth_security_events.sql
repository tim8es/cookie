-- Global identity lifecycle audit. No tenant is required before onboarding.
-- Opaque IDs survive source-row deletion until independent bounded retention.
CREATE TABLE cookie_identity.auth_security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  event_type text NOT NULL CHECK (event_type IN (
    'email_registered','email_login','password_recovered',
    'identity_session_revoked',
    'mail_submitted','mail_skipped','mail_unknown','mail_expired'
  )),
  identity_id uuid,
  mail_job_id uuid,
  CHECK (
    (event_type IN (
      'email_registered','email_login','password_recovered','identity_session_revoked'
    ) AND identity_id IS NOT NULL AND mail_job_id IS NULL)
    OR
    (event_type IN (
      'mail_submitted','mail_skipped','mail_unknown','mail_expired'
    ) AND identity_id IS NULL AND mail_job_id IS NOT NULL)
  )
);
CREATE INDEX auth_security_events_time
  ON cookie_identity.auth_security_events (occurred_at,id);
CREATE INDEX auth_security_events_identity
  ON cookie_identity.auth_security_events (identity_id,occurred_at)
  WHERE identity_id IS NOT NULL;
CREATE INDEX auth_security_events_mail_job
  ON cookie_identity.auth_security_events (mail_job_id)
  WHERE mail_job_id IS NOT NULL;

-- Record terminal transitions, including expiry/crash sweeps, atomically.
CREATE FUNCTION cookie_identity.audit_auth_mail_terminal()
RETURNS trigger LANGUAGE plpgsql AS $audit$
BEGIN
  INSERT INTO cookie_identity.auth_security_events(event_type,mail_job_id)
  VALUES ('mail_' || NEW.status, NEW.id);
  RETURN NEW;
END;
$audit$;
CREATE TRIGGER audit_auth_mail_terminal
AFTER UPDATE OF status ON cookie_identity.auth_mail_jobs
FOR EACH ROW WHEN (
  OLD.status IS DISTINCT FROM NEW.status
  AND NEW.status IN ('submitted','skipped','unknown','expired')
)
EXECUTE FUNCTION cookie_identity.audit_auth_mail_terminal();
