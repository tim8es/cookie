#!/usr/bin/env bash
# The F1 gate definitions are independent of the execution provider.
# Callers supply Node 26/pnpm 10.24.0, Docker, the appropriate disposable
# PostgreSQL service, Chromium, CI=true and TEST_DATABASE_URL as applicable.
# This file never publishes logs or artifacts; the caller owns evidence handling.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

install() { pnpm install --frozen-lockfile; }
lint() { pnpm lint; }
format_check() { pnpm format:check; }
boundaries() { pnpm check:boundaries; }
ui() { pnpm check:ui; }
types() { pnpm typecheck; }
unit() { pnpm test; }
integration() { pnpm test:integration; }
restore() { bash scripts/ci-restore-smoke.sh; }
build() { pnpm build; }
worker() { bash scripts/ci-compiled-synthetic-worker-smoke.sh; }
web() {
  pnpm --filter @cookie/web check
  pnpm --filter @cookie/web build
}
browser() { node apps/web/scripts/browser-smoke.mjs; }
browser_evidence() { node scripts/ci-visual-evidence-check.mjs; }
real_owner() {
  pnpm build:runtime
  node apps/web/scripts/real-owner-browser-smoke.mjs
  node scripts/local-staging.mjs verify
}
staging_readiness() { bash scripts/ci-staging-readiness.test.sh; }
staging_runtime() { bash scripts/ci-staging-compose-smoke.sh; }
pg17_verify() {
  local version
  version=$(docker run --rm --network host -e PGPASSWORD=cookie_ci postgres:17-alpine psql -h 127.0.0.1 -U cookie_ci -d cookie_ci -Atqc 'SHOW server_version_num')
  [[ "$version" == 17* ]] || { echo "Expected PostgreSQL 17, got $version"; exit 1; }
}

if [[ $# != 1 ]]; then
  echo "Expected exactly one F1 gate" >&2
  exit 2
fi
case "$1" in
  install|lint|format_check|boundaries|ui|types|unit|integration|restore|build|worker|web|browser|browser_evidence|real_owner|staging_readiness|staging_runtime|pg17_verify)
    "$1"
    ;;
  quality)
    install
    lint
    format_check
    boundaries
    ui
    types
    unit
    integration
    restore
    build
    worker
    web
    browser
    browser_evidence
    real_owner
    ;;
  staging)
    staging_readiness
    staging_runtime
    ;;
  postgres17)
    install
    pg17_verify
    integration
    ;;
  *)
    echo "Unknown F1 gate" >&2
    exit 2
    ;;
esac
