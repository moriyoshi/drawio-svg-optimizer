#!/usr/bin/env bash
#
# Drive the native font back-ends against real font registries, in Docker.
#
#   ./test/e2e/run.sh                  both halves
#   ./test/e2e/run.sh linux            fontconfig only
#   ./test/e2e/run.sh windows          DirectWrite under Wine only
#   ./test/e2e/run.sh --rebuild        force a fresh image
#
# One image serves both: see the Dockerfile for why, and for why it is
# linux/amd64 even on Apple Silicon.
#
# Exits non-zero if a probe fails. Each probe prints a JSON report either way.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
image="drawio-svg-optimizer-e2e:latest"
dockerfile="test/e2e/Dockerfile"

cd "$root"

rebuild=""
half="both"
for arg in "$@"; do
  case "$arg" in
    --rebuild) rebuild="--no-cache" ;;
    linux | windows | both) half="$arg" ;;
    *)
      echo "usage: run.sh [linux|windows|both] [--rebuild]" >&2
      exit 2
      ;;
  esac
done

if ! docker info > /dev/null 2>&1; then
  echo "error: Docker is not running." >&2
  exit 2
fi

# The image runs the *compiled* back-ends, not the TypeScript. Node cannot
# strip types from sources that import each other with `.js` specifiers, and a
# stale dist/ would silently test the wrong code.
echo "==> Building dist/"
npm run build > /dev/null

# linux/amd64 is not optional: koffi's Windows prebuild is x64, so an arm64
# Wine would have nothing to load. On Apple Silicon this runs under emulation.
echo "==> Building image (linux/amd64; first run pulls Wine and Windows Node)"
docker build $rebuild \
  --platform linux/amd64 \
  -f "$dockerfile" \
  -t "$image" \
  "$root"

echo "==> Running probes: $half"
docker run --rm --platform linux/amd64 "$image" "$half"
