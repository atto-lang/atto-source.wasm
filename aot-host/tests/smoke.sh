#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"
cargo build --manifest-path aot-host/precompile/Cargo.toml
cargo build --manifest-path aot-host/run/Cargo.toml
builder="$repo_dir/aot-host/precompile/target/debug/oreslang-aot-build"
runner="$repo_dir/aot-host/run/target/debug/oreslang-aot-run"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for spec in '42:42' 'zero:0' 'negative:-5'; do
 name="${spec%%:*}"
 result="${spec#*:}"
 if [[ "$name" == 42 ]]; then expected_ir=42
 elif [[ "$name" == zero ]]; then expected_ir=0
 else expected_ir=-5
 fi
 printf 'target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 %s }\n' "$expected_ir" |
   clang --target=wasm32 -x ir -Oz -nostdlib -Wl,--no-entry -Wl,--export=main \
     -Wl,--initial-memory=131072 -Wl,--max-memory=131072 \
     -o "$tmp/$name.wasm" -
 "$builder" "$tmp/$name.wasm" "$tmp/$name.cwasm" > "$tmp/$name.meta"
 pin="$(sed -n 's/^aot_sha256=//p' "$tmp/$name.meta")"
 [[ "$pin" =~ ^[0-9a-f]{64}$ ]] || { echo "missing AOT digest" >&2; exit 1; }
 actual="$("$runner" "$tmp/$name.cwasm" "$pin")"
 [[ "$actual" == "$result" ]] || { echo "AOT result mismatch: $name" >&2; exit 1; }
 if "$runner" "$tmp/$name.cwasm" "$(printf '0%.0s' {1..64})" > /dev/null 2>&1; then
   echo "incorrect digest admitted" >&2; exit 1
 fi
 cp "$tmp/$name.cwasm" "$tmp/$name-corrupt.cwasm"
 python3 - "$tmp/$name-corrupt.cwasm" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
data = bytearray(path.read_bytes())
data[len(data)//2] ^= 1
path.write_bytes(data)
PY
 if "$runner" "$tmp/$name-corrupt.cwasm" "$pin" > /dev/null 2>&1; then
   echo "tampered native artifact admitted" >&2; exit 1
 fi
 # The caller cannot use an original wasm32 .wasm in the native AOT runtime.
 if "$runner" "$tmp/$name.wasm" "$pin" > /dev/null 2>&1; then
   echo "raw wasm wrongly treated as native artifact" >&2; exit 1
 fi
done
# Validate the native file admission boundary without depending on timeouts
# to distinguish a refused FIFO from a blocked O_RDONLY open.
ln -s "$tmp/42.wasm" "$tmp/source-symlink.wasm"
if "$builder" "$tmp/source-symlink.wasm" "$tmp/source-symlink.cwasm" > /dev/null 2>&1; then
  echo "builder followed symlinked Wasm input" >&2; exit 1
fi
ln -s "$tmp/42.cwasm" "$tmp/aot-symlink.cwasm"
pin="$(sed -n 's/^aot_sha256=//p' "$tmp/42.meta")"
if "$runner" "$tmp/aot-symlink.cwasm" "$pin" > /dev/null 2>&1; then
  echo "runner followed symlinked native artifact" >&2; exit 1
fi
mkfifo "$tmp/input.fifo"
set +e
timeout 4s "$builder" "$tmp/input.fifo" "$tmp/from-fifo.cwasm" > /dev/null 2>&1
build_status=$?
timeout 4s "$runner" "$tmp/input.fifo" "$pin" > /dev/null 2>&1
run_status=$?
set -e
if [[ "$build_status" -eq 0 || "$build_status" -eq 124 ||
      "$run_status" -eq 0 || "$run_status" -eq 124 ]]; then
  echo "FIFO input was admitted or blocked indefinitely" >&2; exit 1
fi
echo 'AOT smoke: scalars, digest tampering, wrong module kind, symlink and FIFO denial passed'
