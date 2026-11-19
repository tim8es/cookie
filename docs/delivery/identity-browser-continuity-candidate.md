# F1 identity browser continuity candidate (#309)

Stacked on #352. This implements bounded restoration of an existing global
Identity session and an explicit return from either workspace to the account
chooser. No new tenant selection authority or permissions are minted. Legacy
tenant-bound cs_ credentials remain subject to their existing one-time proof
and migration constraints.

The browser binds an existing is_ bearer to a Secure, HttpOnly, host-only,
SameSite=Strict cookie. Only same-origin browser requests using a dedicated
header can bind or restore. Restoration checks the actual provider, expiry
and revocation; protected business routes still use Authorization and server
tenant permissions. No browser storage or token in URL. Cookie lifetime may
not exceed the already approved session expiry. Logout revokes the exact
bearer and clears a matching cookie; a stale tab cannot erase a different
cookie. Failed network logout is not confirmed.

On reload of the current history entry, restore the last global workspace only
after cookie restoration, current membership and exact context verification.
A tab-local history hint contains only a role and tenant ID, and is consumed
once and rewritten on verified entry. Explicit customer links take precedence;
missing/denied contexts fall back to the chooser. No automatic enrollment or
role grant. Switching from a global account's owner
or customer workspace clears the previous presentation, retains only identity
credentials, and reloads provider/organization context. Legacy sessions do not
show the new switch action.

Not included: refresh-token rotation/long-lived login policy, migration of
legacy Telegram tenant identities, cross-device/new-tab workspace preferences,
full physical-device/WebView and Altare acceptance.
Those remain open #309. The new transport must be exercised in HTTPS staging
with real browser Fetch Metadata and synthetic accounts before merge. No
production rollout or real customer PII.

Browser-bound global sessions also revalidate their cookie after a credential-free
BroadcastChannel signal or focus/page resume. A verified missing or different
cookie invalidates the old UI session without automatically adopting a different
account; network failure is not proof of logout. Memory-only and legacy sessions
do not use this cookie watcher. Protected API calls retain their server checks.
A denied customer-context selection does not revoke a global Identity bearer.
This is best-effort browser convergence, not a distributed lock for simultaneous
HTTP login/logout operations or a new refresh policy.

## Bounded renewal server candidate

An explicitly configured createApp-only option enables a POST renewal route
in engineering tests. Normal runtime bootstrap does not pass the option.
The route requires the existing matching global bearer and the host-only cookie
plus same-origin request metadata; accepts no lifetime from the client. The
provider conditionally updates the already-live session using DB time, with a
sliding configured provider TTL and a non-increasing absolute cap from original
issued_at (at most 3600 seconds). Revocation and renewal serialize on the same
row; an expired/revoked credential cannot be revived. The existing bearer
does not rotate. No new refresh credential, longer login policy or migration.

This is NOT a production-ready refresh-token design. A bearer holder may bind
the bearer to a browser, and overlapping cross-tab login/renew HTTP responses
could overwrite the cookie. Do not enable the route in runtime or add automatic
client retries until the refresh credential/family, logout race, audit and
idle/absolute policy have been independently reviewed. The current UI keeps
its original expiry semantics. Integration and HTTP negative tests are included.

Existing client memberships are selectable in the account chooser without new
enrollment or consent writes; selection uses the same current membership and
server GET-context check as workspace restoration. Explicit customer links
restrict the listing to their tenant. New enrollment remains separate and
requires consent, an available membership list, and the private staging flag.
The optional renewal client transport is tested but not called automatically:
it rejects memory-only/expired credentials, different bearers, regressed
expiry, and revocation; a disabled route does not grant any renewed session.

The dual-role browser regression uses a fresh synthetic identity and a separate
test grant. It verifies owner and client assignments belong to the same identity,
client reload and returning to owner, and subsequent existing-client selection
without a second enrollment or Telegram proof. Enrollment receipt is followed
by live GET-context verification before entering the client UI.

Additional regression: a real second Chromium target opens the shared browser
session without proof, enters the owner workspace, and must clear its visible
workspace after confirmed logout in the first target. Watchers check immediately
on mount as well as on signals to cover the switch/unmount interval. Owner and
identity chooser hide login controls while server logout is pending; destroyed
customer workspaces cannot clear a newly mounted workspace through stale
callbacks. Network-failed logout remains unconfirmed; the server TTL is still
authoritative, and recovery on reload after network failure needs separate review.

If an explicit global logout fails or the document reloads while it is pending,
a strict boolean history-entry guard suppresses silent cookie restoration for
that entry. The guard contains no session token or identity identifier and is
written before the network request, then cleared on confirmed logout or
verified fresh cookie binding. It is not a claim of server revocation, does not
revoke a potentially different account's cookie, and cannot protect a new tab
or a different history entry while the server remains unreachable. The
synthetic browser regression simulates a lost logout request, reloads, and
checks explicit fresh Telegram login before the cross-tab logout scenario.
