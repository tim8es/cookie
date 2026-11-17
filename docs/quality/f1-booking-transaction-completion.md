# F1 Booking transaction completion integrity

Independent current-main engineering fix. The three internal Booking commands
use the same platform-db transaction owner. Return a receipt only after a
successful PostgreSQL COMMIT command tag. A COMMIT exception or ROLLBACK tag,
failed BEGIN, or failed cleanup discards the physical connection. Never
automatically retry a mutation; the original command ID resolves unknown
commit through the existing actor-scoped receipt on a later request.

Authorization, lock order, business rules, original replay semantics, audit
and outbox SQL remain unchanged. In particular, failed business work rolls
back its authorization audit as before. The generic platform helper does
not implement the API protected-reads special denial-audit commit behavior.

Extends the existing real-PG lost-ack regression with a real PostgreSQL
aborted-transaction-before-COMMIT simulation for Create/Reschedule/Cancel.
The server returns ROLLBACK, the command must reject, snapshot stays
unchanged, and the same key can subsequently commit and recover through the
original lost-ack tests. Five driver-level unit tests cover release/reuse.

No new endpoints or customer authentication, no public Booking, no staging
grants or real data. #113/#165 remain open; independent review required.
