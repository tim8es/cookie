# F1 integration proof: real owner workspace

**Draft integration only**, not a candidate for direct merge into main.
Refs #203 #20 #23 #66. No real accounts, external Telegram API, payments,
production or public booking.

Parents:
- #239 shift planning `5b262ab418a16b7be5caad30dc05bd10f819fcdb`
- #238 workspace overview `d053f844a7fdf7c2331efba55ade2c70c7c2388a`
- #236 real owner browser E2E `d1505978d028c3f2fe371fb5fe306ab4e23b6c0a`
- Common earlier #232 locations and #230 staff/catalog stack.

The proof merges the tested sibling trees and explicitly reconciles
Fastify route registration and Svelte navigation so Overview, Services,
Staff, Locations and Schedule coexist in one compiled API-mode app.

The real Chromium scenario drives existing browser forms (not a mock API):
invalid Telegram proof denied -> signed synthetic HMAC login -> Service ->
new Location (Asia/Yekaterinburg) -> Overview displays both branches ->
Staff attached to that created Location and Service -> future local-time
ShiftPlan draft -> exact PostgreSQL IDs, time conversion (10:00–18:00 local
to 05:00–13:00 UTC), one receipt and audit/outbox event, and all publication
flags remain false -> server-confirmed logout -> restart actual compiled
API -> fresh signed launch -> same IDs and persisted results -> viewport
and control labeling at 320/375/1280 CSS pixels.

The original synthetic browser suite, standard lint, typecheck, PG16/17,
restore and Docker CI remain in the workflow inherited from the three
source branches. Current main has subsequently added #201 module ports,
new visual regressions and other review gates; this older-stack proof
cannot substitute for a current-main integration and security review.
Do not merge this verification branch or mark release acceptance. Reconcile
approved source PRs and adapt the test to their latest contracts.
