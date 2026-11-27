#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"
cargo build --locked --manifest-path aot-host/precompile/Cargo.toml --bin oreslang-aot-build --bin oreslang-aot-fixtures
cargo build --locked --manifest-path aot-host/run/Cargo.toml
builder="$repo_dir/aot-host/precompile/target/debug/oreslang-aot-build"
fixtures="$repo_dir/aot-host/precompile/target/debug/oreslang-aot-fixtures"
runner="$repo_dir/aot-host/run/target/debug/oreslang-aot-run"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# The default debug binary must fail closed, even for a genuine AOT artifact.
# Build the deliberately insecure test-only feature after that assertion below.
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
 "$builder" "$tmp/$name.wasm" "$(sha256sum "$tmp/$name.wasm" | cut -d ' ' -f 1)" "$tmp/$name.cwasm" > "$tmp/$name.meta"
 pin="$(sed -n 's/^aot_sha256=//p' "$tmp/$name.meta")"
 [[ "$pin" =~ ^[0-9a-f]{64}$ ]] || { echo "missing AOT digest" >&2; exit 1; }
 if [[ "$name" == 42 ]]; then
   if "$runner" "$tmp/$name.cwasm" "$pin" > "$tmp/default.stdout" 2> "$tmp/default.stderr"; then
     echo "default debug runner admitted caller-controlled AOT artifact" >&2; exit 1
   fi
   if ! grep -q 'AOT execution is disabled unless' "$tmp/default.stderr"; then
     echo "default debug runner failed for unrelated reason" >&2; cat "$tmp/default.stderr" >&2; exit 1
   fi
   cargo build --locked --manifest-path aot-host/run/Cargo.toml --features insecure-dev-caller-pin
 fi
 actual="$("$runner" "$tmp/$name.cwasm" "$pin")"
 [[ "$actual" == "$result" ]] || { echo "AOT result mismatch: $name" >&2; exit 1; }
 if "$runner" "$tmp/$name.cwasm" "$(printf '0%.0s' {1..64})" > /dev/null 2>&1; then
   echo "incorrect digest admitted" >&2; exit 1
 fi
 cp "$tmp/$name.cwasm" "$tmp/$name-corrupt.cwasm"
 "$fixtures" corrupt "$tmp/$name-corrupt.cwasm"
 if "$runner" "$tmp/$name-corrupt.cwasm" "$pin" > /dev/null 2>&1; then
   echo "tampered native artifact admitted" >&2; exit 1
 fi
 # The caller cannot use an original wasm32 .wasm in the native AOT runtime.
 wasm_pin="$(sha256sum "$tmp/$name.wasm" | cut -d ' ' -f 1)"
 if "$runner" "$tmp/$name.wasm" "$wasm_pin" > /dev/null 2>&1; then
   echo "raw wasm wrongly treated as native artifact despite matching digest" >&2; exit 1
 fi
done
# Validate the native file admission boundary without depending on timeouts
# to distinguish a refused FIFO from a blocked O_RDONLY open.
ln -s "$tmp/42.wasm" "$tmp/source-symlink.wasm"
if "$builder" "$tmp/source-symlink.wasm" "$(sha256sum "$tmp/42.wasm" | cut -d ' ' -f 1)" "$tmp/source-symlink.cwasm" > /dev/null 2>&1; then
  echo "builder followed symlinked Wasm input" >&2; exit 1
fi
ln -s "$tmp/42.cwasm" "$tmp/aot-symlink.cwasm"
pin="$(sed -n 's/^aot_sha256=//p' "$tmp/42.meta")"
if "$runner" "$tmp/aot-symlink.cwasm" "$pin" > /dev/null 2>&1; then
  echo "runner followed symlinked native artifact" >&2; exit 1
fi
# The Rust tamper fixture must not follow a swapped AOT symlink either:
# it opens private artifacts with O_NOFOLLOW and rechecks dev/inode/size.
untouched="$(sha256sum "$tmp/42.cwasm" | cut -d ' ' -f 1)"
if "$fixtures" corrupt "$tmp/aot-symlink.cwasm" > /dev/null 2>&1; then
  echo "Rust AOT corruption fixture followed a symlink" >&2; exit 1
fi
if [[ "$(sha256sum "$tmp/42.cwasm" | cut -d ' ' -f 1)" != "$untouched" ]]; then
  echo "Rust tamper fixture mutated the symlink target" >&2; exit 1
fi
# O_NOFOLLOW alone is insufficient: hardlinks alias the same inode. A fixture
# must have exactly one link before we deliberately mutate any bytes.
ln "$tmp/42.cwasm" "$tmp/aot-hardlink.cwasm"
if "$fixtures" corrupt "$tmp/aot-hardlink.cwasm" > /dev/null 2>&1; then
  echo "Rust AOT corruption fixture admitted a multiply-linked inode" >&2; exit 1
fi
if [[ "$(sha256sum "$tmp/42.cwasm" | cut -d ' ' -f 1)" != "$untouched" ]]; then
  echo "Rust tamper fixture mutated a shared hardlink target" >&2; exit 1
fi
rm -- "$tmp/aot-hardlink.cwasm"
mkfifo "$tmp/input.fifo"
set +e
timeout 4s "$builder" "$tmp/input.fifo" "$(sha256sum "$tmp/42.wasm" | cut -d ' ' -f 1)" "$tmp/from-fifo.cwasm" > /dev/null 2>&1
build_status=$?
timeout 4s "$runner" "$tmp/input.fifo" "$pin" > /dev/null 2>&1
run_status=$?
set -e
if [[ "$build_status" -eq 0 || "$build_status" -eq 124 ||
      "$run_status" -eq 0 || "$run_status" -eq 124 ]]; then
  echo "FIFO input was admitted or blocked indefinitely" >&2; exit 1
fi
# These binaries are valid Wasm but violate the strict zero-capability
# precompiler profile. Generic parser rejection would be insufficient proof.
"$fixtures" generate "$tmp"
node --input-type=module - "$tmp" <<'JS'
import {readFileSync} from 'node:fs';
for (const name of ['valid','start','table','extra-memory','import','element','simd','tail-call']) {
  const bytes=readFileSync(process.argv[2]+'/'+name+'.wasm');
  if (!WebAssembly.validate(bytes)) throw Error(name+' negative fixture is malformed');
}
JS
"$builder" "$tmp/valid.wasm" "$(sha256sum "$tmp/valid.wasm" | cut -d ' ' -f 1)" "$tmp/valid.cwasm" > "$tmp/valid.meta"
for reason in start table extra-memory import element simd tail-call; do
  if "$builder" "$tmp/$reason.wasm" "$(sha256sum "$tmp/$reason.wasm" | cut -d ' ' -f 1)" "$tmp/$reason.cwasm" > /dev/null 2>&1; then
    echo "AOT precompiler admitted forbidden $reason section" >&2
    exit 1
  fi
  if [[ -e "$tmp/$reason.cwasm" ]]; then
    echo "AOT precompiler published rejected $reason artifact" >&2
    exit 1
  fi
done
# Publication invariants: an existing AOT file must not be replaced even
# when the source and hash are valid. Publishing a symlink destination must
# not follow or clobber its referent.
orig_pin="$(sha256sum "$tmp/42.cwasm" | cut -d ' ' -f 1)"
if "$builder" "$tmp/42.wasm" "$(sha256sum "$tmp/42.wasm" | cut -d ' ' -f 1)" "$tmp/42.cwasm" > /dev/null 2>&1; then
  echo "precompiler replaced an already-published native artifact" >&2; exit 1
fi
if [[ "$(sha256sum "$tmp/42.cwasm" | cut -d ' ' -f 1)" != "$orig_pin" ]]; then
  echo "published native artifact changed after rejected overwrite" >&2; exit 1
fi
printf 'retain-untouched' > "$tmp/sentinel"
ln -s "$tmp/sentinel" "$tmp/already-linked.cwasm"
if "$builder" "$tmp/42.wasm" "$(sha256sum "$tmp/42.wasm" | cut -d ' ' -f 1)" "$tmp/already-linked.cwasm" > /dev/null 2>&1; then
  echo "precompiler overwrote a symlinked AOT output" >&2; exit 1
fi
if [[ "$(cat "$tmp/sentinel")" != "retain-untouched" ]] ||
   [[ ! -L "$tmp/already-linked.cwasm" ]]; then
  echo "native output symlink or its target was changed" >&2; exit 1
fi
# PR #2 parity: a valid, infinite-looping core-Wasm guest must exhaust
# the Wasmtime store fuel budget without hanging a worker indefinitely.
cat > "$tmp/loop.ll" <<'LLVM'
target triple = "wasm32-unknown-unknown"
define i64 @main() {
entry:
  br label %loop
loop:
  br label %loop
}
LLVM
clang --target=wasm32 -x ir -O0 -nostdlib -Wl,--no-entry -Wl,--export=main \
  -Wl,--initial-memory=131072 -Wl,--max-memory=131072 \
  -o "$tmp/loop.wasm" "$tmp/loop.ll"
"$builder" "$tmp/loop.wasm" "$(sha256sum "$tmp/loop.wasm" | cut -d ' ' -f 1)" "$tmp/loop.cwasm" > "$tmp/loop.meta"
loop_pin="$(sed -n 's/^aot_sha256=//p' "$tmp/loop.meta")"
set +e
timeout 5s "$runner" "$tmp/loop.cwasm" "$loop_pin" 10000 > "$tmp/loop.stdout" 2> "$tmp/loop.stderr"
loop_status=$?
set -e
if [[ "$loop_status" -eq 0 || "$loop_status" -eq 124 || "$loop_status" -eq 137 ]]; then
  echo "loop completed or exceeded wall-time rather than exhausting fuel" >&2
  cat "$tmp/loop.stderr" >&2
  exit 1
fi
for bad_fuel in 0 100000001 not-a-number; do
 if "$runner" "$tmp/42.cwasm" "$(sed -n 's/^aot_sha256=//p' "$tmp/42.meta")" "$bad_fuel" > /dev/null 2>&1; then
  echo "invalid fuel budget was admitted: $bad_fuel" >&2
  exit 1
 fi
done
# End-to-end Wasmtime resource-limiter trap: this valid zero-import Wasm
# guest attempts memory.grow after its declared two-page maximum. By normal
# WebAssembly semantics memory.grow returns -1 and the guest returns 7;
# the deliberately strict native Store policy must instead TRAP. Direct
# ResourceLimiter unit tests do not prove that the guest execution path traps.
cat > "$tmp/growth-denial.c" <<'C'
long long main(void) {
  int previous = __builtin_wasm_memory_grow(0, 1);
  return previous == -1 ? 7LL : 8LL;
}
C
clang --target=wasm32 -x c -O1 -nostdlib -Wno-main-return-type \
  -Wl,--no-entry -Wl,--export=main \
  -Wl,--initial-memory=131072 -Wl,--max-memory=131072 \
  -o "$tmp/growth-denial.wasm" "$tmp/growth-denial.c"
node --input-type=module - "$tmp/growth-denial.wasm" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const bytes = readFileSync(process.argv[2]);
assert.ok(WebAssembly.validate(bytes), 'growth-denial fixture must be valid Wasm');
const module = new WebAssembly.Module(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), [], 'growth-denial fixture has no host imports');
const guest = new WebAssembly.Instance(module);
assert.equal(guest.exports.main(), 7n, 'spec-compliant growth failure must return sentinel');
JS
"$builder" "$tmp/growth-denial.wasm" "$(sha256sum "$tmp/growth-denial.wasm" | cut -d ' ' -f 1)" \
  "$tmp/growth-denial.cwasm" > "$tmp/growth-denial.meta"
growth_pin="$(sed -n 's/^aot_sha256=//p' "$tmp/growth-denial.meta")"
[[ "$growth_pin" =~ ^[0-9a-f]{64}$ ]] || { echo "missing growth-denial AOT digest" >&2; exit 1; }
set +e
timeout 5s "$runner" "$tmp/growth-denial.cwasm" "$growth_pin" \
  > "$tmp/growth-denial.stdout" 2> "$tmp/growth-denial.stderr"
growth_status=$?
set -e
if [[ "$growth_status" -eq 0 || "$growth_status" -eq 124 || "$growth_status" -eq 137 ]]; then
  echo "Wasmtime memory.grow did not promptly trap under strict StoreLimits policy" >&2
  cat "$tmp/growth-denial.stdout" "$tmp/growth-denial.stderr" >&2
  exit 1
fi
if ! grep -Eqi 'trap|error while executing|growth failed|failed to grow|memory growth' "$tmp/growth-denial.stderr"; then
  echo "memory.grow runner failed without guest execution/trap evidence" >&2
  cat "$tmp/growth-denial.stderr" >&2
  exit 1
fi

# Production artifacts may not use the caller-supplied SHA as approval, even
# when somebody forces debug assertions on in a release build.
# Prove the production runner refuses an otherwise authentic native artifact.
cargo build --release --locked --manifest-path aot-host/run/Cargo.toml --features insecure-dev-caller-pin --config profile.release.debug-assertions=true
release_runner="$repo_dir/aot-host/run/target/release/oreslang-aot-run"
# The trusted build-stage input pin must reject a valid Wasm module when
# the supplied digest is wrong; no native code should be published.
wrong_src_pin="$(printf '0%.0s' {1..64})"
if "$builder" "$tmp/42.wasm" "$wrong_src_pin" "$tmp/wrong-source.cwasm" > /dev/null 2>&1; then
  echo "native precompiler accepted incorrect Wasm source pin" >&2; exit 1
fi
if [[ -e "$tmp/wrong-source.cwasm" ]]; then
  echo "native precompiler published mismatched Wasm input" >&2; exit 1
fi
pin="$(sed -n 's/^aot_sha256=//p' "$tmp/42.meta")"
if "$release_runner" "$tmp/42.cwasm" "$pin" > "$tmp/release.stdout" 2> "$tmp/release.stderr"; then
  echo "release runner executed with caller-controlled approval" >&2; exit 1
fi
if ! grep -q 'AOT execution is disabled unless' "$tmp/release.stderr"; then
  echo "release runner failed for an unrelated reason; production denial unverified" >&2
  cat "$tmp/release.stderr" >&2
  exit 1
fi

# Exercise the actual Wasmtime Store-per-tenant registry using one compiled,
# import-free Wasm module with a mutable guest global. Two tenant Stores must
# independently observe 1, then 2. Revoked/recreated tenants start at 1.
# This is an in-process memory isolation check, NOT a process-sandbox proof.
cat > "$tmp/tenant-counter.ll" <<'LLVM'
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
  -Wl,--initial-memory=131072 -Wl,--max-memory=131072 \
  -o "$tmp/tenant-counter.wasm" "$tmp/tenant-counter.ll"
"$builder" "$tmp/tenant-counter.wasm" "$(sha256sum "$tmp/tenant-counter.wasm" | cut -d ' ' -f 1)" \
  "$tmp/tenant-counter.cwasm" > "$tmp/tenant-counter.meta"
tenant_pin="$(sed -n 's/^aot_sha256=//p' "$tmp/tenant-counter.meta")"
[[ "$tenant_pin" =~ ^[0-9a-f]{64}$ ]] || { echo "missing tenant AOT digest" >&2; exit 1; }
tenant_result="$("$runner" --tenant-isolation-smoke "$tmp/tenant-counter.cwasm" "$tenant_pin")"
if [[ "$tenant_result" != "wasmtime_tenant_store_isolation=ok" ]]; then
  echo "Wasmtime tenant-store isolation failed: $tenant_result" >&2
  exit 1
fi
# Unlike an individual Wasmtime out-of-fuel call, this compiled-guest test
# makes repeated successful calls and proves the logical budget is conserved.
conserve_result="$("$runner" --tenant-fuel-conservation-smoke "$tmp/tenant-counter.cwasm" "$tenant_pin")"
if [[ "$conserve_result" != "wasmtime_tenant_fuel_conservation=ok" ]]; then
  echo "Wasmtime tenant lifetime fuel conservation failed: $conserve_result" >&2
  exit 1
fi
if "$runner" --tenant-isolation-smoke "$tmp/tenant-counter.cwasm" "$(printf '0%.0s' {1..64})" > /dev/null 2>&1; then
  echo "tenant smoke bypassed AOT digest check" >&2
  exit 1
fi


# Real guest-memory-growth trap regression: the declared private memory is
# 1..2 pages. On turn 4 the guest requests one additional page: standard Wasm
# ALLOWS this growth. Only the native test-only Store cap of 1 page denies it.
# This isolates the host limiter, not a wasm module maximum. That refusal
# must trap, revoke only the offender, and preserve healthy tenant progress.
cat > "$tmp/tenant-memory-growth.c" <<'C'
typedef unsigned long long u64;
static volatile u64 counter;
long long main(void) {
    u64 current = ++counter;
    if (current == 4) {
        (void)__builtin_wasm_memory_grow(0, 1);
    }
    return (long long)current;
}
C
clang --target=wasm32 -x c -Wno-main-return-type -O0 -nostdlib \
  -Wl,--no-entry -Wl,--export=main -Wl,-z,stack-size=16384 \
  -Wl,--initial-memory=65536 -Wl,--max-memory=131072 \
  -o "$tmp/tenant-memory-growth.wasm" "$tmp/tenant-memory-growth.c"
node --input-type=module - "$tmp/tenant-memory-growth.wasm" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const bytes=readFileSync(process.argv[2]);
assert.ok(WebAssembly.validate(bytes), 'growth fixture must be valid Wasm');
const module=new WebAssembly.Module(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), [], 'no host imports');
assert.deepEqual(WebAssembly.Module.exports(module).map(({name,kind})=>[name,kind]).sort(),
  [['main','function'],['memory','memory']].sort());
const guest=new WebAssembly.Instance(module);
assert.equal(guest.exports.memory.buffer.byteLength,65536,
  'guest must begin at one Wasm page');
assert.deepEqual([guest.exports.main(), guest.exports.main(),
  guest.exports.main(), guest.exports.main()], [1n,2n,3n,4n],
  'normal Wasm must succeed at permitted memory.grow and continue');
assert.equal(guest.exports.memory.buffer.byteLength,131072,
  'standard Wasm must have really grown one page');
console.log('node_standard_wasm_growth_succeeds_under_module_max=ok');
JS
"$builder" "$tmp/tenant-memory-growth.wasm" \
  "$(sha256sum "$tmp/tenant-memory-growth.wasm" | cut -d ' ' -f 1)" \
  "$tmp/tenant-memory-growth.cwasm" > "$tmp/tenant-memory-growth.meta"
growth_pin="$(sed -n 's/^aot_sha256=//p' "$tmp/tenant-memory-growth.meta")"
[[ "$growth_pin" =~ ^[0-9a-f]{64}$ ]] || { echo "missing growth AOT digest" >&2; exit 1; }
growth_result="$("$runner" --tenant-memory-growth-smoke "$tmp/tenant-memory-growth.cwasm" "$growth_pin")"
if [[ "$growth_result" != "wasmtime_tenant_memory_growth_trap=ok" ]]; then
  echo "Wasmtime denied memory growth failed to trap/retire one tenant: $growth_result" >&2
  exit 1
fi
if "$runner" --tenant-memory-growth-smoke "$tmp/tenant-memory-growth.cwasm" \
   "$(printf '0%.0s' {1..64})" > /dev/null 2>&1; then
  echo "growth smoke accepted incorrect AOT digest" >&2
  exit 1
fi

# A real nonterminating Wasm guest, rather than a host-only ResourceLimiter
# invocation. A per-Store fuel budget must interrupt the third turn while a
# healthy tenant survives with independent guest mutable memory. The test
# requires the Wasmtime out-of-fuel cause, not an arbitrary trap or timeout.
cat > "$tmp/tenant-fuel-starvation.c" <<'C'
typedef unsigned long long u64;
static volatile u64 counter;
long long main(void) {
    u64 current = ++counter;
    if (current == 3) {
        volatile u64 busy = 0;
        for (;;) {
            ++busy;
        }
    }
    return (long long)current;
}
C
clang --target=wasm32 -x c -Wno-main-return-type -O0 -nostdlib \
  -Wl,--no-entry -Wl,--export=main -Wl,-z,stack-size=16384 \
  -Wl,--initial-memory=65536 -Wl,--max-memory=131072 \
  -o "$tmp/tenant-fuel-starvation.wasm" "$tmp/tenant-fuel-starvation.c"
node --input-type=module - "$tmp/tenant-fuel-starvation.wasm" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const wasm=readFileSync(process.argv[2]);
assert.ok(WebAssembly.validate(wasm), 'spinning fixture must be valid Wasm');
const module=new WebAssembly.Module(wasm);
assert.deepEqual(WebAssembly.Module.imports(module), [], 'no host imports');
assert.deepEqual(WebAssembly.Module.exports(module).map(({name,kind})=>[name,kind]).sort(),
  [['main','function'],['memory','memory']].sort());
const guest=new WebAssembly.Instance(module);
assert.deepEqual([guest.exports.main(),guest.exports.main()], [1n,2n],
  'the first two turns must complete before the endless loop');
console.log('wasmtime_fuel_fixture_initial_turns=ok');
JS
"$builder" "$tmp/tenant-fuel-starvation.wasm" \
  "$(sha256sum "$tmp/tenant-fuel-starvation.wasm" | cut -d ' ' -f 1)" \
  "$tmp/tenant-fuel-starvation.cwasm" > "$tmp/tenant-fuel-starvation.meta"
spin_pin="$(sed -n 's/^aot_sha256=//p' "$tmp/tenant-fuel-starvation.meta")"
[[ "$spin_pin" =~ ^[0-9a-f]{64}$ ]] || { echo "missing fuel AOT digest" >&2; exit 1; }
spin_result="$("$runner" --tenant-fuel-starvation-smoke "$tmp/tenant-fuel-starvation.cwasm" "$spin_pin" 1000000)"
if [[ "$spin_result" != "wasmtime_tenant_fuel_starvation=ok" ]]; then
  echo "Wasmtime fuel exhaustion isolation failed: $spin_result" >&2
  exit 1
fi
if "$runner" --tenant-fuel-starvation-smoke "$tmp/tenant-fuel-starvation.cwasm" \
   "$(printf '0%.0s' {1..64})" > /dev/null 2>&1; then
  echo "fuel smoke accepted an incorrect AOT digest" >&2
  exit 1
fi

echo 'AOT smoke: positive scalars, strict policy negatives, tenant store/memory-growth/fuel isolation and release-mode denial passed'
