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

On reload, return to the account chooser (or explicit customer route); no
automatic enrollment or role grant. Switching from a global account's owner
or customer workspace clears the previous presentation, retains only identity
credentials, and reloads provider/organization context. Legacy sessions do not
show the new switch action.

Not included: refresh-token rotation/long-lived login policy, migration of
legacy Telegram tenant identities, automatic last-workspace resume, browser
cross-tab synchronization, full physical-device/WebView and Altare acceptance.
Those remain open #309. The new transport must be exercised in HTTPS staging
with real browser Fetch Metadata and synthetic accounts before merge. No
production rollout or real customer PII.
