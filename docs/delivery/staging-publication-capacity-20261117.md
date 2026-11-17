# F1: controlled staging publication capacity (PROPOSED engineering, not commercial policy)

A verified owner sees a real database-backed capacity panel on Masters. Normal API startup explicitly defaults to disabled (POST route absent); a controlled synthetic environment can enable `COOKIE_STAGING_PUBLICATION_MODE=enabled`. No public Booking route or worker provider is enabled.

Only a trusted DB operator can issue one non-renewable, time-bounded grant for an existing synthetic Organization. No automatic grant, trial, paid subscription, pricing, offer or payment. Explicitly choose a positive integer seat limit; no product default. Example for an already provisioned synthetic tenant (supply values via local/staging env, not repository files):

```sh
# DB credentials supplied securely by operator environment.
export COOKIE_OPERATOR_STAGING_PUBLICATION=synthetic-only-acknowledged
export COOKIE_STAGING_TENANT_ID='<synthetic tenant UUID>'
export COOKIE_STAGING_SEAT_LIMIT='<explicit positive test limit>'
export COOKIE_STAGING_EXPIRES_AT='<future UTC ISO timestamp, milliseconds and Z>'
pnpm db:staging-publication-grant issue
# revoke (permanent for this synthetic grant):
pnpm db:staging-publication-grant revoke
```

GET/POST /v1/organizations/:tenantId/staging-publication require a verified bearer, current organization-scoped **non-delegable owner permission**, and server-side tenant isolation. POST requires an explicit selection (StaffProfile, assigned Location, Service, expected service revision) and replay key. Staff-first lock → policy/session locks → exclusive grant lock → service/assignment locks → writes and durable receipt; recheck grant time before commit. Count unique active bookable StaffProfiles, not location assignments or available shifts; conservatively count even if no active assignment (DEC-109). Grant expiry/revoke denies new publications, does not auto-disable profiles, erase records, change pricing or upgrade. Duplicate same-key replay checks current authority and current grant; the receipt is not current state. New draft profiles remain creatable at full capacity. Activated service revision increments and publication history cannot be cleared by an ordinary update. Existing shifts stay inactive. UI refreshes actual database state after the operation. No disabling/archiving, additional active assignment mutation, renewal, downgrade, commercial trial clock/cap or price tiers. Future capacity-changing commands must use the same lock protocol.

Commercial DEC-099/101/103/105/107/109/111/113 remain the source of truth. Trial capacity and exact timezone/DST semantics are unresolved; real offer acceptance, voluntary paid consent, payment evidence, audit/retention and antiabuse are not implemented. This is only an explicit operator-controlled engineering capability required for #203 controlled staging. Do not grant real tenant access or expose public booking. #113/#165/#175 and legal/deployment gates still apply. Independent review required before combining with the other active branches (#241, #238, #231).

Current-main integration: reused platform-db transaction owner (#255) for Staff publication and operator grant issuance; commit tag must be acknowledged, uncertain clients discarded. Concurrent identical first issue converges to the same grant under unique tenant key; pre-write policy denial audit commits without domain writes. Preserve combined browser proof #240 and historical service publication regression. No commercial entitlement or public Booking approval.
