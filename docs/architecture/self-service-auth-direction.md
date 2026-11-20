# Self-service identity and selectable authentication

Owner direction 2026-11-17; implementation proposed. Tracking: #309, #12, #22, #23, #66, #203. This updates the login choices in ADR-0004; its Identity, Membership, Organization and tenant-scoped Customer boundaries remain in force.

## Product behavior

- A person can register and sign in as a business user or customer, using Telegram, email/password, or either when both are enabled. An Identity may have both business memberships and customer profiles.
- A business user creates an Organization and completes onboarding without an operator. The authenticated Identity and server-created membership, not a client-supplied tenant or role, establish authority.
- A customer may browse and select service, staff and time before signing in or registering immediately before booking confirmation. Preserve the selection through authentication. The server rechecks availability, price, authorization and entitlement at confirmation; a selected slot is not a reservation.
- An installation can enable Telegram only, email/password only, or both. Future authentication methods are separate adapters; business modules consume verified Identity and session capabilities, not provider-specific claims. Configuration, delivery and recovery must work for both SaaS and self-hosted deployments.
- Linking a second method to an existing account requires authenticated intent and verified control of that method. Never merge accounts by unverified email, phone, display name or Telegram username. Prevent removal or disabling of the only usable login method without a reviewed recovery path. Existing Telegram links must be migrated without changing their meaning or losing access.

## Engineering boundaries

Identity owns provider configuration, proof validation, credential lifecycle, account linking and revocable sessions. Authorization remains server-enforced, tenant and resource scoped. Customer records remain scoped to their Organization; a user's customer and business access are not interchangeable. Disabled providers cannot authenticate through hidden routes, and incomplete configuration fails closed.

Telegram Mini App signed initData and web Telegram login are distinct entry points requiring their own verified protocols. Email/password requires secure password hashing, verified email, recovery, abuse controls and a delivery adapter; choose exact algorithms and providers in implementation review. Keep credentials, raw Telegram proof, reset tokens and session tokens out of logs. Recovery links require single-use short-lived tokens and protection from referrer and analytics leakage. Do not store bearer tokens in persistent browser storage.

## Delivery and evidence

1. Define provider-neutral identity, session and account-linking contracts, migration and configuration, preserving existing session and revocation guarantees.
2. Implement independent Telegram and email/password registration/login with verified linking, recovery and configuration; expose only enabled methods.
3. Implement self-service business creation and onboarding; add customer sign-in at confirmation with server-side revalidation and idempotent booking.
4. Verify provider combinations, forged/replayed proofs, account takeover and linking conflicts, cross-tenant access, session revocation, recovery and concurrent booking; exercise the actual web/API/database path and restart on staging.

No item above asserts completion, authorizes production data or changes the current controlled-staging gates. Existing operator-linked Telegram is an engineering mechanism, not the product registration flow. Guest booking without an account, installation-wide versus tenant-specific provider policy, email delivery provider and account recovery UX require separate decisions; none is implied by this document.

