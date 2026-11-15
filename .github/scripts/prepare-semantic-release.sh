#!/usr/bin/env bash
# Adapted from UPM's .github/scripts/prepare-release.sh.
set -euo pipefail
runtime="${1:?runtime is required}"
version="${2:?version is required}"
branch="${3:?branch is required}"
[[ "$branch" == main || "$branch" == dev ]] || { echo "Invalid release branch" >&2; exit 1; }
python3 .github/scripts/runtime-version.py "$runtime" "$version"
export GITHUB_ACTOR="${GPR_USER:-${GITHUB_ACTOR:-github-actions}}"
export GITHUB_TOKEN="${GPR_READ_PACKAGES_TOKEN:-${GITHUB_TOKEN:-}}"
# Backmerge can stash the workflow's chmod; do not depend on the executable bit.
build_log="$(mktemp)"
trap 'rm -f "$build_log"' EXIT
for attempt in 1 2 3; do
  if bash ./gradlew assembleRelease -PruntimeId="$runtime" 2>&1 | tee "$build_log"; then
    break
  else
    statuses=("${PIPESTATUS[@]}")
    # A logging failure is not a dependency download failure.
    [[ "${statuses[1]}" == 0 ]] || exit "${statuses[1]}"
    status="${statuses[0]}"
  fi
  # Retry only temporary network/server failures, before signing or publication.
  if [[ "$attempt" == 3 ]] || ! grep -Eiq \
    'Received status code (429|5[0-9]{2})|[Cc]onnection (reset|timed out)|[Rr]ead timed out|[Tt]emporary failure in name resolution' "$build_log"; then
    exit "$status"
  fi
  delay=$((attempt * 30))
  echo "::warning::Temporary dependency download failure for $runtime; retrying in ${delay}s (attempt $((attempt + 1))/3)."
  sleep "$delay"
done
rm -f "$build_log"
trap - EXIT
python3 .github/scripts/prepare-runtime-release.py "$runtime" --tag "$runtime-v$version" --build-tools "$ANDROID_HOME/build-tools/36.0.0"
