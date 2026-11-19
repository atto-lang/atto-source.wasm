#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
repo="$PWD"
node --input-type=module <<'NODE'
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const m=JSON.parse(readFileSync('ci/native-aot/source-provenance.json','utf8'));
const seed=m.source_blobs;
const current=m.current_source_blobs;
const entries=Object.entries(current||{});
if(m.schema!=='atto.source-wasm-seeded-native-aot-prototype.v1' ||
   !seed||entries.length!==12||
   Object.keys(seed).length!==12 ||
   entries.some(([path,sha])=>
     !path.startsWith('aot-host/') ||
     path.includes('..') ||
     !/^[0-9a-f]{40}$/.test(sha) ||
     !Object.hasOwn(seed,path)))
  throw Error('invalid native AOT provenance schema');
let migrated=0;
for(const [path,expected] of entries){
  const actual=execFileSync('git',['hash-object','--',path],{encoding:'utf8'}).trim();
  if(actual!==expected)throw Error('native AOT current blob mismatch: '+path);
  if(actual!==seed[path])migrated++;
}
const extensions=Object.entries(m.local_test_extensions||{});
for(const [path,meta] of extensions){
  if(!Object.hasOwn(current,path) || !Object.hasOwn(seed,path) ||
      !/^aot-host\\/[a-zA-Z0-9_./-]+$/.test(path) ||
      path.includes('..') ||
      meta.upstream_sha!==seed[path] ||
      meta.current_sha!==current[path] ||
      !/^[0-9a-f]{40}$/.test(meta.current_sha) ||
      meta.current_sha===meta.upstream_sha)
    throw Error('invalid local native AOT Rust test-extension provenance');
}
console.log('NATIVE_AOT_LOCAL_EXTENSIONS_VERIFIED='+extensions.length);
console.log('NATIVE_AOT_CURRENT_BLOBS_VERIFIED='+entries.length);
console.log('NATIVE_AOT_HISTORIC_SEED_REPLACEMENTS='+migrated);
console.log('NATIVE_AOT_ORIGIN_HEAD='+m.origin.commit);
console.log('NATIVE_AOT_RECONCILIATION_PARENT='+m.current_snapshot.base_commit);
NODE
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
python3 -m unittest discover -s tests -p 'test_atto_scalar_aot_bridge.py' -v
echo 'SCOPE=NATIVE_WASMTIME_DEV_PROTO_ONLY_NO_COMPILED_ATTO_LANG_OR_PRODUCTION_SANDBOX'
