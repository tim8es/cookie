# Minimal kernel — next F1 step (#17)

The kernel owns registry, lifecycle, module manifests, capability wiring and versioned ports. It must **not** import business entities, booking, pricing, PostgreSQL or delivery channel adapters.

**F1 PR #16 intentionally contains no kernel business logic or implemented lifecycle.** The first concrete kernel contracts and tests belong in Issue #17. `pnpm check:boundaries` guards the current dependency direction; the full contract/boundary test suite will expand with #17.
