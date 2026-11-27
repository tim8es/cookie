#!/usr/bin/env bash
# Real, compiled API + API-mode web + persistent PostgreSQL integration smoke.
# CI-only disposable environment; never run this against a customer database.
set -euo pipefail
[[ "${CI:-}" == "true" ]] || { echo "CI=true is required"; exit 1; }
command -v docker >/dev/null
command -v curl >/dev/null
command -v openssl >/dev/null
source scripts/lib/ci-cookie-ready.sh

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
if ! cookie_wait_ready "http://127.0.0.1:$COOKIE_HTTP_PORT/health/ready" 90 2; then
  echo "API readiness failed after initial startup" >&2
  exit 1
fi
# The compiled API serves the same static web directly for one-app Altare hosting.
"${compose[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/').then(async (r) => { if (!r.ok || !(await r.text()).includes('<html')) process.exitCode=1 }).catch(() => process.exitCode=1)"
curl --silent --fail "http://127.0.0.1:$COOKIE_HTTP_PORT/" | grep -qi '<html'
status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$COOKIE_HTTP_PORT/v1/organizations/00000000-0000-4000-8000-000000000000/bookings")"
[[ "$status" == "404" ]] || { echo "Unapproved booking route became public (HTTP $status)"; exit 1; }

count="$("${compose[@]}" exec -T postgres psql -U cookie -d cookie -Atqc 'SELECT count(*) FROM public.cookie_schema_migrations')"
expected_count="$(find db/migrations -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d '[:space:]')"
[[ "$count" == "$expected_count" ]] || {
  echo "Migration count mismatch: applied=$count files=$expected_count"; exit 1;
}
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
if ! cookie_wait_ready "http://127.0.0.1:$COOKIE_HTTP_PORT/health/ready" 60 2; then
  echo "API failed to regain readiness after PostgreSQL/API restart" >&2
  exit 1
fi
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
# Unlike the coordinated restart above, force an actual database outage
# while the API stays running with an already-used pool. Docker's restart
# policy must not hide a Node crash: compare identity AND restart metadata.
api_container="$("${compose[@]}" ps -q api)"
[[ -n "$api_container" ]] || { echo "Missing API container"; exit 1; }
api_process_stamp() {
  docker inspect --format '{{.Id}} {{.RestartCount}} {{.State.StartedAt}}' "$api_container"
}
api_stamp_before="$(api_process_stamp)"
# Confirm direct API health before disrupting the private Compose database.
probe_api_health() {
  "${compose[@]}" exec -T api node --input-type=module - "$1" "$2" "$3" <<'NODE'
const [path, expectedCode, expectedStatus] = process.argv.slice(2);
const response = await fetch("http://127.0.0.1:3000" + path, {
  signal: AbortSignal.timeout(8000),
});
const body = await response.json();
if (response.status !== Number(expectedCode) || body.status !== expectedStatus) {
  process.exitCode = 1;
}
NODE
}
probe_api_health /health/ready 200 ready
"${compose[@]}" stop postgres >/dev/null
# The HTTP process must remain reachable while authoritative readiness fails.
probe_api_health /health/live 200 ok
probe_api_health /health/ready 503 not-ready
probe_api_health /health/live 200 ok
[[ "$(api_process_stamp)" == "$api_stamp_before" ]] || {
  echo "API restarted during PostgreSQL outage"; exit 1;
}
# Replay of even a known committed operator operation must never report
# success from memory when its authoritative database is unavailable.
if outage_owner="$("${owner_command[@]}" 2>&1)"; then
  echo "Owner provisioning incorrectly succeeded during database outage"; exit 1
fi
[[ "$outage_owner" == *'provisioning failed: SETUP_FAILED'* ]] || {
  echo "Expected sanitized operator failure during PostgreSQL outage"; exit 1;
}
echo "PASS: database outage yields HTTP 503 readiness, live API, and failed owner command"
"${compose[@]}" start postgres >/dev/null
if ! cookie_wait_ready "http://127.0.0.1:$COOKIE_HTTP_PORT/health/ready" 60 2; then
  echo "API failed to recover after PostgreSQL-only restart" >&2
  exit 1
fi
probe_api_health /health/ready 200 ready
[[ "$(api_process_stamp)" == "$api_stamp_before" ]] || {
  echo "API recovered only through a process restart"; exit 1;
}
recovered_owner="$("${owner_command[@]}")"
[[ "$recovered_owner" == "$replayed_owner" ]] || {
  echo "Owner replay after DB-only recovery differs from original replay"; exit 1;
}
owner_count_after_outage="$("${compose[@]}" exec -T postgres psql -U cookie -d cookie -Atqc "
  SELECT count(*) FROM cookie_tenancy.owner_setup_receipts
  WHERE owner_identity_id='$COOKIE_OWNER_IDENTITY_ID'::uuid
")"
[[ "$owner_count_after_outage" == "1" ]] || {
  echo "Database outage/recovery duplicated or lost owner receipt"; exit 1;
}
value_after_outage="$("${compose[@]}" exec -T postgres psql -U cookie -d cookie -Atqc 'SELECT value FROM public.cookie_runtime_ci_persistence')"
[[ "$value_after_outage" == "42" ]] || { echo "Lost durable data after outage"; exit 1; }
echo "PASS: same compiled API process recovered PostgreSQL connectivity; durable owner receipt and data unchanged"
echo "Compiled API + same-origin web + verified migrations + owner provisioning/replay + persistent PostgreSQL restart PASS; Booking routes remain fail-closed."
# Separate, dedicated real-OS Linux codec sandbox proof. No routes are
# activated in the API; never mount a Docker socket in the app container.
bash scripts/ci-codec-sandbox-smoke.sh
