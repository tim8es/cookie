-- F1 internal-only Outbox alert operations. No external delivery transport.
-- Existing alert journal and delivery queue migrations are immutable.
ALTER TABLE cookie_jobs.outbox_alert_delivery
  ADD COLUMN lease_started_at timestamptz,
  ADD COLUMN manual_replay_count integer NOT NULL DEFAULT 0
    CHECK (manual_replay_count BETWEEN 0 AND 3);

-- Existing in-flight leases from the prior version are intentionally
-- NOT eligible for renewal (lease_started_at remains NULL). They expire
-- normally and are reclaimed or dead-lettered by the existing claim path.

CREATE TABLE cookie_jobs.outbox_alert_replay_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transition_id bigint NOT NULL
    REFERENCES cookie_jobs.outbox_alert_transitions(id) ON DELETE RESTRICT,
  operator_identity_id uuid NOT NULL
    REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  replay_number integer NOT NULL CHECK (replay_number BETWEEN 1 AND 3),
  previous_attempts integer NOT NULL CHECK (previous_attempts BETWEEN 0 AND 25),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (transition_id, replay_number)
);

-- Immutable replay outcomes for one trusted operator/key. No raw keys stored.
-- A successfully committed replay can be recovered after a lost COMMIT ACK.
CREATE TABLE cookie_jobs.outbox_alert_replay_receipts (
  operator_identity_id uuid NOT NULL
    REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  key_sha256 char(64) NOT NULL CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  transition_id bigint NOT NULL
    REFERENCES cookie_jobs.outbox_alert_transitions(id) ON DELETE RESTRICT,
  requeued boolean NOT NULL,
  replay_count integer CHECK (replay_count BETWEEN 0 AND 3),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (operator_identity_id, key_sha256)
);
CREATE INDEX outbox_alert_replay_audit_transition
  ON cookie_jobs.outbox_alert_replay_audit (transition_id, created_at);
