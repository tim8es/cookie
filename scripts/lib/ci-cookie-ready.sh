#!/usr/bin/env bash
# Source in staging smoke scripts; deterministic readiness verification.
# Both HTTP success and authoritative JSON readiness are required.
cookie_wait_ready() {
  local url="${1:?Expected URL}" attempts="${2:?Expected attempts}" delay="${3:?Expected delay}"
  local body=""
  for ((attempt=1; attempt<=attempts; attempt++)); do
    if body="$(curl --silent --fail --max-time 2 "$url" 2>/dev/null)" &&
       [[ "$body" == *'"status":"ready"'* ]]; then
      return 0
    fi
    if ((attempt<attempts)); then sleep "$delay"; fi
  done
  return 1
}
