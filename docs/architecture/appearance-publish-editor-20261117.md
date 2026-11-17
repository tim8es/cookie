# Controlled-staging Appearance editor publication

Refs #223/#203; depends on #297. Private publication state endpoint returns only a revision snapshot and advisory ability to publish, separately checking read rights, then publish rights/live staging grant. Absence or failure is not interpreted as "never published". The two checks may observe different moments; POST always independently evaluates current permission and the locked grant, saved revision and asset ownership. No grant ID, public URL or draft data appears in this status DTO.

Owner editor publishes only a saved unchanged revision, only when the positive capability matches the locally loaded revision. Strict response validates revision and canonical config. Reloads actual draft and publication state; no auto retry after uncertain commit, no optimistic status. A later revision or unavailable state means refresh before further publication. Publication refers to the stored configuration only, not activation of public booking. Both upload and publish remain off in ordinary main.

Test coverage: real signed PG status transitions (missing/active/revoked grant, published/draft revisions, runtime absence), transport receipt mismatch, stale status and no retry. Actual mounted compiled web interaction plus public delivery, grant race and deployment security remain gates. No new migration or business defaults.
