#!/usr/bin/env bash
# Real, compiled API + API-mode web + persistent PostgreSQL integration smoke.
# CI-only disposable environment; never run this against a customer database.
set -euo pipefail
[[ "${CI:-}" == "true" ]] || { echo "CI=true is required"; exit 1; }
command -v docker >/dev/null
command -v curl >/dev/null
command -v openssl >/dev/null

export COOKIE_DB_PASSWORD="$(openssl rand -hex 32)"
export COOKIE_HTTP_PORT=18080
project="cookie-stage-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
compose=(docker compose -p "$project" -f docker-compose.staging.yml)
cleanup() {
  status=$?
  trap - EXIT
  if (( status != 0 )); then
    "${compose[@]}" ps || true
    "${compose[@]}" logs --tail=100 || true
  fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

"${compose[@]}" config >/dev/null
"${compose[@]}" up --build -d
for attempt in $(seq 1 90); do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:$COOKIE_HTTP_PORT/health/ready" > /tmp/cookie-staging-ready.json; then
    break
  fi
  sleep 2
done
grep -q '"status":"ready"' /tmp/cookie-staging-ready.json
# The compiled API serves the same static web directly for one-app Altare hosting.
"${compose[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/').then(async (r) => { if (!r.ok || !(await r.text()).includes('<html')) process.exitCode=1 }).catch(() => process.exitCode=1)"
curl --silent --fail "http://127.0.0.1:$COOKIE_HTTP_PORT/" | grep -qi '<html'
status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$COOKIE_HTTP_PORT/v1/organizations/00000000-0000-4000-8000-000000000000/bookings")"
[[ "$status" == "404" ]] || { echo "Unapproved booking route became public (HTTP $status)"; exit 1; }

count="$("${compose[@]}" exec -T postgres psql -U cookie -d cookie -Atqc 'SELECT count(*) FROM public.cookie_schema_migrations')"
(( count >= 24 )) || { echo "Migrations were not applied: $count"; exit 1; }
"${compose[@]}" exec -T postgres psql -U cookie -d cookie -v ON_ERROR_STOP=1 -c 'CREATE TABLE public.cookie_runtime_ci_persistence (value integer NOT NULL)' >/dev/null
"${compose[@]}" exec -T postgres psql -U cookie -d cookie -v ON_ERROR_STOP=1 -c 'INSERT INTO public.cookie_runtime_ci_persistence(value) VALUES (42)' >/dev/null

# Exercise the actual COMPILED server-side owner provisioning command, not TS/mocks.
export COOKIE_OWNER_IDENTITY_ID="$(node -e 'console.log(require("node:crypto").randomUUID())')"
export COOKIE_OWNER_SETUP_KEY="$(node -e 'console.log(require("node:crypto").randomUUID())')"
owner_command=(
  "${compose[@]}" exec -T
  -e COOKIE_OPERATOR_BOOTSTRAP=acknowledged
  -e "COOKIE_OWNER_IDENTITY_ID=$COOKIE_OWNER_IDENTITY_ID"
  -e "COOKIE_OWNER_SETUP_KEY=$COOKIE_OWNER_SETUP_KEY"
  -e "COOKIE_OWNER_ORGANIZATION=CI Staging Salon"
  -e "COOKIE_OWNER_LOCATION=Main branch"
  -e "COOKIE_OWNER_TIME_ZONE=Europe/Moscow"
  api node dist/packages/platform-identity/src/bootstrap-owner-cli.js
)
first_owner="$("${owner_command[@]}")"
[[ "$first_owner" == *'"replayed":false'* ]] || {
  echo "First real owner creation did not commit"; exit 1;
}
owner_count="$("${compose[@]}" exec -T postgres psql -U cookie -d cookie -Atqc "
  SELECT count(*) FROM cookie_tenancy.owner_setup_receipts
  WHERE owner_identity_id='$COOKIE_OWNER_IDENTITY_ID'::uuid
")"
[[ "$owner_count" == "1" ]] || {
  echo "Expected exactly one durable owner setup receipt"; exit 1;
}

"${compose[@]}" restart postgres api >/dev/null
for attempt in $(seq 1 60); do
  if curl --silent --fail --max-time 2 "http://127.0.0.1:$COOKIE_HTTP_PORT/health/ready" | grep -q '"status":"ready"'; then
    break
  fi
  sleep 2
done
value="$("${compose[@]}" exec -T postgres psql -U cookie -d cookie -Atqc 'SELECT value FROM public.cookie_runtime_ci_persistence')"
[[ "$value" == "42" ]] || { echo "PostgreSQL lost persisted state after restart"; exit 1; }
replayed_owner="$("${owner_command[@]}")"
[[ "$replayed_owner" == *'"replayed":true'* ]] || {
  echo "Owner setup did not replay after PostgreSQL restart"; exit 1;
}
owner_count_after_restart="$("${compose[@]}" exec -T postgres psql -U cookie -d cookie -Atqc "
  SELECT count(*) FROM cookie_tenancy.owner_setup_receipts
  WHERE owner_identity_id='$COOKIE_OWNER_IDENTITY_ID'::uuid
")"
[[ "$owner_count_after_restart" == "1" ]] || {
  echo "PostgreSQL restart duplicated or lost owner workspace"; exit 1;
}
echo "Compiled API + same-origin web + 24 migrations + owner provisioning/replay + persistent PostgreSQL restart PASS; Booking routes remain fail-closed."
