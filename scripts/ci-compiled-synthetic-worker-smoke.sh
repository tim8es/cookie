#!/usr/bin/env bash
# CI-only proof that the built worker launches under Node, not tsx.
set -euo pipefail

[[ "${CI:-}" == "true" ]] || { echo "CI=true is required"; exit 1; }
[[ -n "${TEST_DATABASE_URL:-}" ]] || { echo "TEST_DATABASE_URL is required"; exit 1; }

worker="dist/apps/api/src/synthetic-worker-main.js"
[[ -f "$worker" ]] || { echo "Built synthetic worker entrypoint is missing"; exit 1; }

log="$(mktemp)"
cleanup() {
  rm -f "$log"
}
trap cleanup EXIT

# Require the actual security guard to reject each case, not a missing
# build artifact/dependency or some unrelated startup failure.
assert_rejected() {
  if "$@" >"$log" 2>&1; then
    echo "Unsafe synthetic worker invocation was accepted"
    exit 1
  fi
  if ! grep -q "Synthetic worker may only run on an explicit local/CI test database" "$log"; then
    echo "Worker exited for an unexpected reason, not the configuration guard"
    exit 1
  fi
}

assert_rejected env -u COOKIE_SYNTHETIC_WORKER DATABASE_URL="$TEST_DATABASE_URL" node "$worker"
assert_rejected env COOKIE_SYNTHETIC_WORKER=enabled DATABASE_URL="postgresql://cookie_ci:cookie_ci@not-local.invalid:5432/cookie_ci" node "$worker"
assert_rejected env COOKIE_SYNTHETIC_WORKER=enabled TEST_DATABASE_URL="postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/not_cookie_ci" DATABASE_URL="$TEST_DATABASE_URL" node "$worker"

# The fixture harness uses tsx only to seed/check isolated PostgreSQL rows.
# The process under test is always the compiled dist/ JavaScript entrypoint.
pnpm exec tsx apps/api/test/compiled-worker-delivery-smoke.ci.ts
echo "Compiled synthetic worker: configuration guards and actual PostgreSQL delivery passed."
