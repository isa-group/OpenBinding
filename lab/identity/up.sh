#!/usr/bin/env bash
# Start the SCORETech Identity lab at its pinned revision (lab/identity/README.md).
#
# Clones SCORELabUS/SCORETech-identity into .lab/scoretech-identity (gitignored), checks out and verifies the pinned
# commit, optionally pre-pulls the published provider image (IDENTITY_PROVIDER_IMAGE) to skip the Maven build, and runs
# its own `./lab up` with OpenBinding's lab origin allowed back from the account pages. Refuses to start when the ports
# are taken or the docker host lacks the memory for both stacks.
set -Eeuo pipefail

PIN=215dffedf556294e2424f7c7b4e9bf57d038d66f
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
DIR=${IDENTITY_LAB_DIR:-$ROOT/.lab/scoretech-identity}
SOURCE=${IDENTITY_LAB_SOURCE:-https://github.com/SCORELabUS/SCORETech-identity.git}
OB_PORT=${OB_IDENTITY_LAB_PORT:-18198}
# The OB lab's memory limits (lab/tests/test_lab_compose.py EXPECTED_MIB), Identity's (~3 GiB) and a margin.
OB_MIB=$(sed -n 's/^EXPECTED_MIB = \([0-9]*\).*/\1/p' "$ROOT/lab/tests/test_lab_compose.py")
NEED_MIB=$(( ${OB_MIB:-3936} + 3072 + 256 ))

for port in 18000 18025 "$OB_PORT"; do
  if docker ps --format '{{.Ports}}' | grep -q "127.0.0.1:${port}->"; then
    echo "identity lab: port $port is already published by another container; stop that stack first" >&2
    exit 1
  fi
done
available=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
if [ "${available:-0}" -lt "$NEED_MIB" ] && [ -z "${IDENTITY_LAB_SKIP_MEMORY_CHECK:-}" ]; then
  echo "identity lab: ${available} MiB available, ${NEED_MIB} MiB needed for Identity and the OB lab together" >&2
  exit 1
fi

if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet "$SOURCE" "$DIR"
fi
git -C "$DIR" cat-file -e "$PIN^{commit}" 2>/dev/null || git -C "$DIR" fetch --quiet origin "$PIN"
git -C "$DIR" checkout --quiet --detach "$PIN"
if [ "$(git -C "$DIR" rev-parse HEAD)" != "$PIN" ]; then
  echo "identity lab: $DIR is not at $PIN" >&2
  exit 1
fi
if [ -n "${IDENTITY_PROVIDER_IMAGE:-}" ]; then
  docker pull --quiet "$IDENTITY_PROVIDER_IMAGE" && docker tag "$IDENTITY_PROVIDER_IMAGE" scoretech-identity-provider:local
fi
cd "$DIR"
IDENTITY_ACCOUNT_RETURN_ORIGINS="http://localhost:${OB_PORT}" ./lab up
