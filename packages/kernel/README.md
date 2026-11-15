# Cookie minimal kernel — F1 / Issue #17

Trusted in-process TypeScript registry and lifecycle, with **no business entities** and no dependence on database, bookings, channels, billing or AI.

## Manifest and lifecycle
- Each module has a stable lowercase kebab-case ID, semantic version, provided capability names/versions and required capability ranges.
- Supported version ranges: exact `x.y.z`, `^x.y.z`, `~x.y.z` and `*`. Prerelease and composite version expressions are intentionally rejected until a versioning ADR.
- The graph is checked before startup for duplicate IDs/providers, missing or incompatible capabilities and cycles. Providers register/start before their consumers; stop runs in reverse.
- `register(context)` publishes exactly the capabilities declared by the manifest. `start(context)` can resolve **only** declared, already-running dependencies. This is trusted module wiring, not an authorization bypass for an external caller.
- Required startup failures halt and unwind the host. Optional modules can be disabled at construction or fail during startup without stopping independent required modules. If an essential consumer depends on a failed optional provider, startup fails closed.
- A kernel instance starts once and stops once; create a new instance to restart. Snapshots report module state without leaking port implementations.

## Scope and security
This registry wires **operator-installed trusted code**. It does **not** dynamically load untrusted plugins or activate a feature for a tenant. Tenant entitlements, user permissions, request/correlation context, audit, and command execution policy belong to platform/domain ports and must be enforced before business actions.

## Validation
`pnpm test` runs kernel lifecycle/contract tests, `pnpm check:boundaries` prohibits higher-level imports into kernel, and `pnpm build` includes kernel in the distribution. CI evidence is required before the Issue is accepted.
