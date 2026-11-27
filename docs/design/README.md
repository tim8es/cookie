# kuki — Design & Design System

**Current visual reference: RC9.4**, candidate for implementation and independent visual review. Owner requested repository storage on 2026-11-27. Not final Design Freeze, runtime acceptance, or approval of new commercial/F2 scope.

## Start here

- [Local reference launcher](rc9.4/index.html): direct links to visual scenarios and component examples.
- [Verification and integration map](rc9.4/VERIFICATION.md): recorded prototype QA, remaining evidence and mapping to existing Rhythm components.
- [RC9.4 handoff](rc9.4/HANDOFF.md): architecture, screen-to-code mapping, dependencies, migration and acceptance.
- [Component contracts](rc9.4/COMPONENTS.md): 32 reference contracts and state/interaction rules.
- [Token reference](rc9.4/token-reference.json): measured prototype values; runtime canonical tokens remain `apps/web/src/styles/tokens.css`.
- [Application HTML](rc9.4/kuki-concept-rc9.4.html) and [component catalog HTML](rc9.4/kuki-components-rc9.4.html): self-contained visual/interaction references on synthetic data.
- [Agent implementation prompt](rc9.4/AGENT_PROMPT.md).
- [Screen registry](screen-registry.md) and [foundation roadmap](design-foundation-roadmap-20261118.md).
- [Design epic #338](https://github.com/tim8es/cookie/issues/338), [active Rhythm kit PR #382](https://github.com/tim8es/cookie/pull/382).

GitHub displays HTML source; clone the branch and open the files locally (or run a private local static server). For explicit demo controls use `?review=1`. These are not deployable runtime pages. No real data.

## Integration sequence

1. D1/D6: reconcile RC9.4 contracts with #382 (RC7.1-based kit), extend existing Svelte UI/token foundation, do not duplicate it.
2. D2/D4: migrate actual workspace shell and existing server-backed vertical flows; preserve permissions, navigation and data.
3. D3: shared Booking UI using approved backend contracts; keep missing public runtime routes fail-closed until #222 and relevant dependencies are complete.
4. D5: F2 extensions only when existing scope/dependencies permit. D7: independent visual/functional acceptance against actual implementation on the same SHA.

See HANDOFF.md for gates; don't promote historical prototype PASS to runtime PASS. The full original archive, prior RC9.3 source, original QA scripts and screenshots remain in the project library. The reference HTML, contracts, token snapshot, launcher, raw JSON reports and copy audit are stored here byte-for-byte. See VERIFICATION.md for provenance and exact remaining limitations.
