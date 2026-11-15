-- F1 infrastructure-only global Outbox health state. No real alert transport.
-- All monitor replicas must share this ONE PostgreSQL singleton row.
-- A single row lock serializes state reconciliation and transition insertions.
CREATE TABLE cookie_jobs.outbox_alert_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  active jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(active) = 'object'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO cookie_jobs.outbox_alert_state (singleton, active, revision)
VALUES (true, '{}'::jsonb, 0);

-- Audit of changes is append-only from the application contract; no tenant,
-- payload, URL, secrets, customer identity or event message are persisted.
-- A revision groups the changes from one atomic health sample.
CREATE TABLE cookie_jobs.outbox_alert_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  revision bigint NOT NULL CHECK (revision > 0),
  code text NOT NULL CHECK (code IN
    ('DUE_BACKLOG', 'OLDEST_DUE', 'EXPIRED_LEASES',
     'DEAD_LETTERS', 'METRICS_UNAVAILABLE')),
  kind text NOT NULL CHECK (kind IN
    ('raised', 'escalated', 'deescalated', 'resolved')),
  previous_severity text CHECK (previous_severity IN ('warning','critical')),
  severity text CHECK (severity IN ('warning','critical')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (revision, code),
  CONSTRAINT outbox_alert_transition_valid CHECK (
    (kind = 'raised' AND previous_severity IS NULL AND severity IS NOT NULL)
    OR (kind = 'resolved' AND previous_severity IS NOT NULL AND severity IS NULL)
    OR (kind = 'escalated' AND previous_severity = 'warning'
      AND severity = 'critical')
    OR (kind = 'deescalated' AND previous_severity = 'critical'
      AND severity = 'warning')
  )
);
CREATE INDEX outbox_alert_transitions_revision
  ON cookie_jobs.outbox_alert_transitions (revision, id);
