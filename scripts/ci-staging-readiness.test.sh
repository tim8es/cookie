#!/usr/bin/env bash
# This regression runs independently of Docker; verifies #214's false-PASS case.
set -euo pipefail
source scripts/lib/ci-cookie-ready.sh

# Database still answers SELECT, but the API never becomes ready.
db_sentinel=42
[[ "$db_sentinel" == "42" ]]
calls=0
curl() { calls=$((calls+1)); printf '%s' '{"status":"ready"}'; return 22; }
if cookie_wait_ready "http://127.0.0.1:1/health/ready" 2 0; then
  echo "BUG: HTTP 503 with a ready-looking body produced PASS" >&2
  exit 1
fi

curl() { printf '%s' '{"service":"cookie-api","status":"not-ready"}'; }
if cookie_wait_ready "http://127.0.0.1:1/health/ready" 2 0; then
  echo "BUG: 200 not-ready produced PASS" >&2
  exit 1
fi

# A later successful HTTP response should allow the environment to recover.
# For command-substitution subshells do not rely on a mutating shell counter.
curl() { printf '%s' '{"service":"cookie-api","status":"ready"}'; }
if ! cookie_wait_ready "http://127.0.0.1:1/health/ready" 1 0; then
  echo "BUG: legitimate readiness rejected" >&2
  exit 1
fi
echo "PASS: API readiness failure cannot be masked by a healthy database"
