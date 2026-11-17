# Portable external CI (opt-in pilot)

Status: implementation candidate; do not enable until the checks below pass.
The existing F1 workflow remains authoritative. No deployment or real data.

## Operating model

The portable suite runner provisions its own disposable PostgreSQL 16 or 17
on loopback. Staging uses the existing local Docker Compose smoke. All three
suites retain the existing gate commands. The standalone runner requires
Docker, npm, Chromium/Chrome, Python 3 and a disposable Linux host; it installs
Node major 26 and pnpm 10.24.0 using npm. No persistent self-hosted machine
should run untrusted code or share its Docker daemon with other projects.

The external adapter is an optional implementation of the existing v1 generic
manifest contract. A trusted controller publishes three independent manifests
and dispatches only opaque random IDs. It never sends the source slug, SHA or
suite to the public workflow. The worker verifies its exact detached SHA,
captures logs and approved visual evidence in a temporary ZIP, and sends the
ZIP only to a separately verified private GitHub evidence repository. The
controller requires both a successful exact run ID and matching evidence
metadata/digest before setting a success commit status. A missing archive,
failed upload, bad SHA, cancelled or timed out run is not green. Statuses are
reported against the tested SHA, not a different PR head.

## Configuration (operator only; values never commit)

Use independently scoped short-lived credentials. An existing private registry
may be reused after checking its current ref and access model. Choose a separate,
dedicated private evidence repository, initialized with a default branch.
No public repository or shared project source is an acceptable evidence sink.

Controller environment:
- CI_REGISTRY_REPO and CI_REGISTRY_REF (default main)
- CI_REGISTRY_WRITE_TOKEN: Contents write, registry only
- CI_EXECUTION_REPO and CI_RUNNER_DISPATCH_TOKEN: Actions read/write, executor only
- CI_EVIDENCE_REPO and CI_EVIDENCE_READ_TOKEN: Contents read, evidence repo only
- CI_SOURCE_STATUS_TOKEN: Contents read and Commit statuses write, source only
- EXTERNAL_CI_APPROVED=1: explicit opt-in only after provider-policy and security review

The generic executor's existing registry/access configuration must have
Contents read on only the required registry and source(s), and its private
secret map must contain the aliases ci_evidence_repo and
ci_evidence_write_token (Contents write on dedicated evidence repo only).
Do not replace other consumers' secret values or grant source-write permission.
Do not give the worker the controller/status/dispatch credentials. The v1
executor is a trusted-code host, not a sandbox: environment filtering is not
a guarantee against hostile code, parent-process inspection or network leaks.

## Manual pilot

On a trusted controller machine, from a reviewed checkout, use:
- `python3 scripts/ci/external_ci.py plan example/private-source <full-sha> quality`
  (offline manifest preview, private terminal only).
- `python3 scripts/ci/external_ci.py dispatch example/private-source <full-sha>`
  (explicit approved/private-only execution; three concurrent jobs, blocking
  reconciliation for up to one hour; never run it from an unreviewed PR).

The dispatcher expects the workflow-dispatch REST response to include its
specific run ID. Do not re-dispatch blindly on an ambiguous API error. Check
pending statuses and cancel orphaned runs through the trusted controller.
Run at most one controller invocation per source SHA at a time. For an actual
PR, resolve and verify the current merge SHA and gate that exact SHA before
merge; do not treat an old successful status or a head-only check as equivalent.

## Acceptance and remaining work

1. Validate standalone suite parity on the same commit and record three green
   native checks, three green portable checks and synthetic-only evidence.
2. Confirm source, registry and evidence are private; rotate any exposed
   historical secrets. Verify provider usage is permitted before dispatching.
3. Pilot authorized trusted code; inspect public workflow logs/artifacts/caches
   for absence of private markers and verify the private archive contents.
4. Test failing gates, API/release failure, cancellation, stale SHA, replay and
   duplicate dispatch. A public run exposes generic actor/timing/status.
5. Add a trusted external event controller for internal PR updates, exact
   merge-SHA resolution, supersession/locking, durable reconciliation and
   private evidence retention. Do not give secrets to fork/unreviewed code.
   Do not keep a private hosted job polling for an hour on every PR.
6. Verify GitHub plan supports enforcement, then activate required checks and
   only then retire duplicated workflows. A private self-hosted runner is the
   supported alternative if external hosted execution is not permitted.

The current pilot has no automatic dispatch, no production secrets, and no
public artifact upload. Evidence is private by access control, not encrypted
end-to-end. Releases need an explicit retention/deletion policy before use
at scale. No source/runtime business modules are changed.
