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
controller requires both a successful exact run ID/attempt and matching evidence
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
- CI_EXECUTION_REPO, CI_EXECUTION_SHA (reviewed full 40-character executor main commit), and CI_RUNNER_DISPATCH_TOKEN: Actions read/write and Contents read, executor only
- CI_EVIDENCE_REPO and CI_EVIDENCE_READ_TOKEN: Contents read, evidence repo only
- CI_SOURCE_STATUS_TOKEN: Contents read, Pull requests read and Commit statuses write, source only
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
5. Validate the implemented trusted controller for internal PR updates, exact
   merge-SHA resolution, supersession/locking, and durable reconciliation.
   Set a private evidence retention procedure. Do not give secrets to fork or
   unreviewed code. Do not keep a private hosted job polling for an hour on every PR.
6. Verify GitHub plan supports enforcement, then activate required checks and
   only then retire duplicated workflows. A private self-hosted runner is the
   supported alternative if external hosted execution is not permitted.

The implementation includes an opt-in automated controller but it is not installed
or enabled. There are no configured production secrets or public artifact uploads. Evidence is private by access control, not encrypted
end-to-end. Releases need an explicit retention/deletion policy before use
at scale. No source/runtime business modules are changed.


## Automated controller (trusted Linux service)

Install the reviewed controller from the protected default branch into a
separate trusted Linux environment. Keep the code and credentials outside PR
worktrees; do not install it on the public execution host. Use a dedicated
service account, a mode-0700 persistent state directory and a protected
mode-0600 environment file or external secret manager. Add the controller
configuration above and `CI_TRUSTED_REVIEWERS`, a comma-separated allowlist
of authorized reviewer logins. The source token also needs Pull requests:read.

Run the following from a trusted scheduler, e.g. once per minute:

```sh
python3 /opt/private-ci/scripts/ci/controller.py example/private-source \\
  --state-dir /var/lib/private-ci
```

In one tick the controller checks the current main SHA and the open internal,
non-draft PRs targeting main. A PR only qualifies after an allowlisted reviewer
approves its exact current head SHA; a new push requires a new approval. It
verifies the generated merge commit's two exact parents against the current
main and approved head, then submits three independent jobs. Each PR revision
has a persistent record; an advisory lock prevents concurrent local controller
instances. It cancels superseded jobs, validates original run ID / attempt,
and never promotes stale or unverifiable evidence. At most four revisions are
active. An ambiguous dispatch is terminal/error until an operator reconciles
it; do not blindly remove the journal or resubmit. Review journal and private
provider run history after failures. The controller does not yet automate
retention, recovery of ambiguous dispatches or multi-host HA.

Only start one controller for this source, not the manual dispatcher at the
same time. A trusted main revision is tested after merge. Keep the existing
native CI required until the whole integration has passed on the exact SHA,
including negative/cancel cases. A successful external status is not a review
approval. Automatic polling does not override protected-branch restrictions.

## Provider policy and supported alternative

Review GitHub Terms for Additional Products and Features before using
GitHub-hosted runners in a different repository: running unrelated projects
on a public repository's hosted runner is restricted. This adapter does not
confer authorization; leave EXTERNAL_CI_APPROVED unset unless use of the chosen
provider is permitted. The recommended no-hosted-minute route is a dedicated,
ephemeral self-hosted runner in the private source repository, retaining native
F1 checks. Never attach a privileged persistent runner to a public repository.


The native F1 workflow stays on GitHub-hosted runners by default, even when
the source becomes private (subject to private compute quota). Only the
explicit repository variable F1_EXECUTION_BACKEND=self-hosted, in a private
repository, selects the dedicated cookie-ci-private runner. Register and
validate an ephemeral Linux runner before setting that variable. Removing
the variable restores hosted routing; do not assume unlimited free compute.

Executor provenance: the controller checks the reviewed executor main SHA
before publishing/dispatching a job and stores it in the journal; both
manual and scheduled paths reject run metadata that differs (including
reruns). The API returns the run identity explicitly. Dispatch still uses
main because the generic executor requires that branch: a ref change
between verification and dispatch is possible. The post-run check prevents
false green but cannot prevent unreviewed code from running. Protect and
freeze executor main during pilots; require independent review and a trusted,
immutable invocation mechanism or equivalent operator-controlled runner
before routine execution with private credentials. No external activation is
authorized by this change; native checks remain authoritative.
