#!/usr/bin/env bash
# Private WebAssembly exact-tree v3 dispatcher; never evaluate caller-provided commands.
set -euo pipefail
if [[ $# -ne 7 || "${2:-}" != --source-pr || "${4:-}" != --source-commit || "${6:-}" != --test-plan ]]; then
  printf '%s\n' 'PRIVATE_CI_DESTINATION_REJECTED: usage: run-in-private-ci-destination.sh owner/repo --source-pr POSITIVE_INTEGER --source-commit FULL_40_HEX_SHA --test-plan ci/test-plans/NAME.json' >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$script_dir/publish-private-ci-source-v3.py" "$@"
