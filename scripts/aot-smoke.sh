#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

printf 'target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 42 }\n' \
  | clang --target=wasm32 -x ir -Oz -nostdlib \
    -Wl,--no-entry -Wl,--export=main \
    -Wl,--initial-memory=131072 -Wl,--max-memory=131072 \
    -o "$dir/scalar.wasm" -
node --input-type=module - "$dir/scalar.wasm" <<'NODE'
import {readFileSync} from "node:fs";
import {admitCoreGuest} from "./src/guest-admission.mjs";
const bytes=readFileSync(process.argv[2]);
const a=admitCoreGuest(bytes);
if(a.imports!==0||a.memoryMaximumPages!==2)process.exit(1);
NODE
cargo build --release --manifest-path native/aot-builder/Cargo.toml
cargo build --release --manifest-path native/aot-runner/Cargo.toml
builder=native/aot-builder/target/release/oreslang-wasm-aot-build
runner=native/aot-runner/target/release/oreslang-wasm-aot-run
wasm_sha="$(sha256sum "$dir/scalar.wasm" | cut -d ' ' -f1)"
"$builder" "$dir/scalar.wasm" "$wasm_sha" "$dir/scalar.cwasm"
aot_sha="$(sha256sum "$dir/scalar.cwasm" | cut -d ' ' -f1)"
"$runner" "$dir/scalar.cwasm" "$aot_sha" 1000000 | grep -qx 'result_i64=42'
if "$runner" "$dir/scalar.cwasm" "$(printf '%064d' 0)" 1000000; then
 echo "ERROR: corrupt pin accepted" >&2
 exit 1
fi
printf '\0' >> "$dir/scalar.cwasm"
if "$runner" "$dir/scalar.cwasm" "$aot_sha" 1000000; then
 echo "ERROR: mutated native artifact accepted" >&2
 exit 1
fi

printf 'target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { entry: br label %%loop\nloop: br label %%loop\n }\n' \
  | clang --target=wasm32 -x ir -O0 -nostdlib \
    -Wl,--no-entry -Wl,--export=main \
    -Wl,--initial-memory=131072 -Wl,--max-memory=131072 \
    -o "$dir/loop.wasm" -
loop_sha="$(sha256sum "$dir/loop.wasm" | cut -d ' ' -f1)"
"$builder" "$dir/loop.wasm" "$loop_sha" "$dir/loop.cwasm"
loop_aot_sha="$(sha256sum "$dir/loop.cwasm" | cut -d ' ' -f1)"
if "$runner" "$dir/loop.cwasm" "$loop_aot_sha" 10000; then
 echo "ERROR: out-of-fuel guest completed" >&2
 exit 1
fi
echo "Native Wasmtime AOT smoke passed"
