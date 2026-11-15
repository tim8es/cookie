-- F1 synthetic-only alert transition delivery queue (no provider transport).
-- Keep immutable 0015 journal unchanged; delivery status is stored separately.
-- Any newly inserted transition receives a queue row in the SAME transaction.
CREATE TABLE cookie_jobs.outbox_alert_delivery (
  transition_id bigint PRIMARY KEY
    REFERENCES cookie_jobs.outbox_alert_transitions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','leased','delivered','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5
    CHECK (max_attempts BETWEEN 1 AND 25),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_until timestamptz,
  delivered_at timestamptz,
  last_failure_code text
    CHECK (last_failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CONSTRAINT alert_delivery_attempts_bounded CHECK (attempts <= max_attempts),
  CONSTRAINT alert_delivery_status_consistent CHECK (
    (status = 'leased' AND lease_token IS NOT NULL
      AND lease_until IS NOT NULL AND delivered_at IS NULL)
    OR (status IN ('pending', 'dead') AND lease_token IS NULL
      AND lease_until IS NULL AND delivered_at IS NULL)
    OR (status = 'delivered' AND lease_token IS NULL
      AND lease_until IS NULL AND delivered_at IS NOT NULL)
  )
);

CREATE INDEX alert_delivery_claim_due
  ON cookie_jobs.outbox_alert_delivery (available_at, transition_id)
  WHERE status = 'pending';
CREATE INDEX alert_delivery_claim_expired
  ON cookie_jobs.outbox_alert_delivery (lease_until, transition_id)
  WHERE status = 'leased';

CREATE FUNCTION cookie_jobs.enqueue_alert_transition_delivery()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cookie_jobs.outbox_alert_delivery (transition_id)
  VALUES (NEW.id);
  RETURN NEW;
END $$;

CREATE TRIGGER enqueue_alert_transition_delivery
  AFTER INSERT ON cookie_jobs.outbox_alert_transitions
  FOR EACH ROW EXECUTE FUNCTION cookie_jobs.enqueue_alert_transition_delivery();

-- Preserve preexisting committed journal rows on upgrade. No transport runs.
INSERT INTO cookie_jobs.outbox_alert_delivery (transition_id)
SELECT id FROM cookie_jobs.outbox_alert_transitions
ON CONFLICT (transition_id) DO NOTHING;
