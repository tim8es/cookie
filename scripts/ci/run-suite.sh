#!/usr/bin/env bash
# Portable suite on a disposable Linux host. Never target an existing database.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
[[ $# == 1 ]] || exit 2
case "$1" in quality|postgres17|staging) suite=$1 ;; *) exit 2 ;; esac
export CI=true
unset DATABASE_URL TEST_DATABASE_URL
command -v docker >/dev/null
docker info >/dev/null
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 26 ]]
[[ "$(pnpm --version)" == 10.24.0 ]]
container=""
cleanup() {
  if [[ -n "$container" ]]; then docker rm -f -v "$container" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
if [[ "$suite" != staging ]]; then
  major=16
  [[ "$suite" != postgres17 ]] || major=17
  container=$(docker run -d --rm -p 127.0.0.1:5432:5432 \
    -e POSTGRES_USER=cookie_ci -e POSTGRES_PASSWORD=cookie_ci -e POSTGRES_DB=cookie_ci \
    "postgres:$major-alpine")
  ready=false
  for ((i=0;i<60;i++)); do
    if docker exec "$container" pg_isready -h 127.0.0.1 -U cookie_ci -d cookie_ci >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  [[ "$ready" == true ]]
  version=$(docker exec "$container" psql -h 127.0.0.1 -U cookie_ci -d cookie_ci -Atqc 'SHOW server_version_num')
  [[ "$version" == "$major"* ]]
  export TEST_DATABASE_URL=postgresql://cookie_ci:cookie_ci@127.0.0.1:5432/cookie_ci
fi
if [[ "$suite" == quality ]]; then
  command -v google-chrome >/dev/null || command -v google-chrome-stable >/dev/null || command -v chromium >/dev/null || command -v chromium-browser >/dev/null
fi
bash scripts/ci/f1-gates.sh "$suite"
