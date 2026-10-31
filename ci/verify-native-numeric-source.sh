#!/usr/bin/env bash
set -euo pipefail

verify_blob() {
  local expected="$1"
  local path="$2"
  test -f "$path"
  local actual
  actual="$(git hash-object "$path")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'numeric source drift: %s expected %s got %s\n' "$path" "$expected" "$actual" >&2
    exit 1
  fi
  printf 'verified %s %s\n' "$actual" "$path"
}

verify_blob 725309eb0edae4d32ffbfe159b05fc7d4091bcc1 stdlib/math.ores
verify_blob bf05aa719812ee4f47a4228e1b2a8e97fc7fba9b stdlib/bigint.ores
verify_blob 501c964afa7b4746c6fe2fbd6847db5f9ec0db74 stdlib/decimal.ores
verify_blob bb2ac7be846f6e58692cb00ad049955ce228c873 contracts/v1/numeric-error-abi.json
verify_blob 508fa36c43d1986cb469dcb64803e69c538d68a1 contracts/v1/native-error-slot-v1.h
