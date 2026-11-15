-- F1 controlled manual dead-letter replay. Every migration is immutable.
-- No event payload is copied into audit. Event ID stays fixed for provider dedupe.
ALTER TABLE cookie_jobs.outbox_events
  ADD COLUMN manual_replay_count integer NOT NULL DEFAULT 0
  CONSTRAINT outbox_replay_count_limit CHECK (manual_replay_count BETWEEN 0 AND 3);

CREATE TABLE cookie_jobs.outbox_replay_audit (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES cookie_tenancy.organizations(id) ON DELETE RESTRICT,
  event_id uuid NOT NULL REFERENCES cookie_jobs.outbox_events(id) ON DELETE RESTRICT,
  actor_identity_id uuid NOT NULL REFERENCES cookie_identity.identities(id) ON DELETE RESTRICT,
  correlation_id text NOT NULL CHECK (length(correlation_id) BETWEEN 1 AND 128),
  replay_number integer NOT NULL CHECK (replay_number BETWEEN 1 AND 3),
  previous_attempts integer NOT NULL CHECK (previous_attempts BETWEEN 1 AND 25),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (event_id, replay_number)
);
CREATE INDEX outbox_replay_audit_by_tenant
  ON cookie_jobs.outbox_replay_audit (tenant_id, created_at DESC, id DESC);
