#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
repo="$PWD"
python3 - <<'PY'
import json, subprocess
from pathlib import Path
m=json.loads(Path("ci/native-aot/source-provenance.json").read_text())
for path,sha in m["source_blobs"].items():
    actual=subprocess.check_output(["git","hash-object",path],text=True).strip()
    if actual!=sha: raise SystemExit(f"mismatch: {path}: {actual} != {sha}")
for path,meta in m.get("local_test_extensions",{}).items():
    actual=subprocess.check_output(["git","hash-object",path],text=True).strip()
    if actual!=meta["current_sha"] or actual==meta["upstream_sha"]:
        raise SystemExit(f"LOCAL_TEST_EXTENSION_MISMATCH: {path}")
print(f"LOCAL_TEST_EXTENSION_BLOBS_VERIFIED={len(m.get('local_test_extensions',{}))}")
print(f"UPSTREAM_GIT_BLOBS_VERIFIED={len(m['source_blobs'])}")
print(f"UPSTREAM_SOURCE_HEAD={m['origin']['commit']}")
PY
cargo test --locked --manifest-path aot-host/precompile/Cargo.toml
cargo test --locked --manifest-path aot-host/run/Cargo.toml
cargo build --locked --manifest-path aot-host/precompile/Cargo.toml
cargo build --locked --manifest-path aot-host/run/Cargo.toml
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
runner="$repo/aot-host/run/target/debug/oreslang-aot-run"
if "$runner" > "$tmp/default-out" 2> "$tmp/default-err"; then
  echo 'default AOT runner incorrectly admitted code' >&2; exit 1
fi
grep -q 'AOT execution is disabled unless' "$tmp/default-err" || {
  echo 'default AOT runner denial not exercised' >&2; cat "$tmp/default-err"; exit 1;
}
echo 'native_aot_default_fail_closed=ok'
cargo build --locked --manifest-path aot-host/run/Cargo.toml --features insecure-dev-caller-pin
builder="$repo/aot-host/precompile/target/debug/oreslang-aot-build"
# Independent per-tenant linear memory: one precompiled module and distinct Stores.
cat > "$tmp/counter.ll" <<'LLVM'
target triple = "wasm32-unknown-unknown"
@counter = internal global i64 0, align 8
define i64 @main() {
entry:
  %old = load volatile i64, ptr @counter, align 8
  %next = add i64 %old, 1
  store volatile i64 %next, ptr @counter, align 8
  ret i64 %next
}
LLVM
clang --target=wasm32 -x ir -Oz -nostdlib -Wl,--no-entry -Wl,--export=main \
  -Wl,--initial-memory=131072 -Wl,--max-memory=131072 -o "$tmp/counter.wasm" "$tmp/counter.ll"
"$builder" "$tmp/counter.wasm" "$(sha256sum "$tmp/counter.wasm" | cut -d ' ' -f 1)" \
  "$tmp/counter.cwasm" > "$tmp/counter.meta"
pin="$(sed -n 's/^aot_sha256=//p' "$tmp/counter.meta")"
[[ "$pin" =~ ^[a-f0-9]{64}$ ]] || { echo 'missing AOT digest' >&2; exit 1; }
test "$("$runner" --tenant-isolation-smoke "$tmp/counter.cwasm" "$pin")" = 'wasmtime_tenant_store_isolation=ok'
echo 'native_wasmtime_distinct_store_guest=ok'
# Real guest executes two finite turns, then loops forever on its third turn.
cat > "$tmp/spin.c" <<'C'
typedef unsigned long long u64;
static volatile u64 counter;
long long main(void) {
  u64 current = ++counter;
  if (current == 3) {
    volatile u64 spin = 0;
    for (;;) ++spin;
  }
  return (long long)current;
}
C
clang --target=wasm32 -x c -Wno-main-return-type -O0 -nostdlib -Wl,--no-entry \
  -Wl,--export=main -Wl,-z,stack-size=16384 \
  -Wl,--initial-memory=65536 -Wl,--max-memory=131072 -o "$tmp/spin.wasm" "$tmp/spin.c"
node --input-type=module - "$tmp/spin.wasm" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const bytes=readFileSync(process.argv[2]);
assert.ok(WebAssembly.validate(bytes));
const module=new WebAssembly.Module(bytes);
assert.deepEqual(WebAssembly.Module.imports(module),[]);
const instance=new WebAssembly.Instance(module);
assert.deepEqual([instance.exports.main(),instance.exports.main()],[1n,2n]);
JS
"$builder" "$tmp/spin.wasm" "$(sha256sum "$tmp/spin.wasm" | cut -d ' ' -f 1)" \
  "$tmp/spin.cwasm" > "$tmp/spin.meta"
spin_pin="$(sed -n 's/^aot_sha256=//p' "$tmp/spin.meta")"
[[ "$spin_pin" =~ ^[a-f0-9]{64}$ ]] || { echo 'missing spinning AOT digest' >&2; exit 1; }
test "$("$runner" --tenant-fuel-starvation-smoke "$tmp/spin.cwasm" "$spin_pin" 1000000)" = 'wasmtime_tenant_fuel_starvation=ok'
if "$runner" --tenant-fuel-starvation-smoke "$tmp/spin.cwasm" "$(printf '0%.0s' {1..64})" > /dev/null 2>&1; then
  echo 'insecure development digest mismatch was accepted' >&2; exit 1
fi
echo 'native_wasmtime_spinning_guest_fuel_retirement=ok'
echo 'SCOPE=NATIVE_WASMTIME_DEV_PROTO_ONLY_NO_COMPILED_ATTO_LANG_OR_PRODUCTION_SANDBOX'
