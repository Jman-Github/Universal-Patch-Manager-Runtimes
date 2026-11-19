#!/usr/bin/env bash

assemble_release_with_retry() (
  set -euo pipefail
  local build_log attempt status delay
  local -a statuses
  build_log="$(mktemp)"
  trap 'rm -f "$build_log"' EXIT

  for attempt in 1 2 3; do
    if bash ./gradlew assembleRelease "$@" 2>&1 | tee "$build_log"; then
      return 0
    else
      statuses=("${PIPESTATUS[@]}")
      # A logging failure is not a dependency download failure.
      [[ "${statuses[1]}" == 0 ]] || return "${statuses[1]}"
      status="${statuses[0]}"
    fi
    if [[ "$attempt" == 3 ]] || ! grep -Eiq \
      'Received status code (429|5[0-9]{2})|[Cc]onnection (reset|timed out)|[Rr]ead timed out|[Tt]emporary failure in name resolution' "$build_log"; then
      return "$status"
    fi
    delay=$((attempt * 30))
    echo "::warning::Temporary dependency download failure; retrying in ${delay}s (attempt $((attempt + 1))/3)."
    sleep "$delay"
  done
)
