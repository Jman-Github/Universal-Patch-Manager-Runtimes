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
./gradlew assembleRelease -PruntimeId="$runtime"
python3 .github/scripts/prepare-runtime-release.py "$runtime" --tag "$runtime-v$version" --build-tools "$ANDROID_HOME/build-tools/36.0.0"
