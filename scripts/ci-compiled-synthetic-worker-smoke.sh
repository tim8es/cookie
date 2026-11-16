#!/usr/bin/env bash
# CI-only proof that the built worker launches under Node, not tsx.
set -euo pipefail

[[ "${CI:-}" == "true" ]] || { echo "CI=true is required"; exit 1; }
[[ -n "${TEST_DATABASE_URL:-}" ]] || { echo "TEST_DATABASE_URL is required"; exit 1; }

worker="dist/apps/api/src/synthetic-worker-main.js"
[[ -f "$worker" ]] || { echo "Built synthetic worker entrypoint is missing"; exit 1; }

log="$(mktemp)"
worker_pid=""
cleanup() {
  if [[ -n "$worker_pid" ]]; then
    kill -TERM "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
  fi
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

COOKIE_SYNTHETIC_WORKER=enabled DATABASE_URL="$TEST_DATABASE_URL" node "$worker" >"$log" 2>&1 &
worker_pid=$!
sleep 1
if ! kill -0 "$worker_pid" 2>/dev/null; then
  echo "Compiled synthetic worker terminated before SIGTERM"
  wait "$worker_pid" || true
  exit 1
fi
kill -TERM "$worker_pid"
wait "$worker_pid"
worker_pid=""
echo "Compiled synthetic worker: three fail-closed cases and SIGTERM shutdown passed."
