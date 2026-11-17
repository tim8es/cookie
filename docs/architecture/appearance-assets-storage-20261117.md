# F1 Appearance normalized asset storage

Status: storage only; #223/#203 remain open. No HTTP upload/publish or public asset delivery is mounted by this change.

A caller-owned, policy-checked PostgreSQL READ COMMITTED transaction can persist trusted codec output as a bounded immutable PNG (at most 2 MiB, 1–4096 px per axis). The existing Appearance store uses an ownership capability that locks the same tenant/kind asset row. An original submitted image, declared MIME, filename or opaque identifier is never sufficient. The structural PNG header check is NOT a decoder, metadata sanitizer, or security validation of attacker bytes.

Use a reviewed bounded decoder/re-encoder for PNG/JPEG/WebP before calling the store. Its dependency, CPU/memory limits, pixel/animation constraints and actual cross-platform tests remain necessary. No raw upload URL or provider is introduced. A private HTTP adapter must verify the actual actor and same-transaction permissions, use a quota/retention policy, and must not expose bytes or draft assets anonymously. Public delivery must resolve the published tenant and asset reference only, with content-type and no-sniff response headers.

The store deduplicates by tenant, kind and SHA-256, returning the original opaque ID for an identical normalized image. It does not reuse one tenant's asset ID in another tenant. It verifies byte equality on dedupe. There is no update-in-place. Save/publish use FOR KEY SHARE; deletion takes FOR UPDATE on the asset and checks both committed draft and published references afterwards. The deletion path intentionally does not lock the branding row, to avoid reversing the writer's row lock order. Callers must use these capabilities, not direct SQL, and preserve READ COMMITTED semantics. A future deletion API must add retention/audit and permission review. No automatic garbage collection or commercial quota is implied.

Migration ordinal 0041 is reserved in #223/#203, leaving 0040 for the concurrently developed reschedule slice. Reconcile all migration branches before combining and do not rewrite applied migration files.

Evidence required: real PostgreSQL tenant/kind isolation, identical concurrent content dedupe, persistence, reference/deletion tests, then deterministic concurrent save/delete tests before any upload/deletion runtime mount. Full feature acceptance also requires real codec, auth, UI, accessibility and published customer page.
