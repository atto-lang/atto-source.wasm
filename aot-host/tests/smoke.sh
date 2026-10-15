#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"
cargo build --locked --manifest-path aot-host/precompile/Cargo.toml
cargo build --locked --manifest-path aot-host/run/Cargo.toml
builder="$repo_dir/aot-host/precompile/target/debug/oreslang-aot-build"
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
python3 aot-host/tests/make-negative-wasm.py "$tmp"
node --input-type=module - "$tmp" <<'JS'
import {readFileSync} from 'node:fs';
for (const name of ['valid','start','table','extra-memory','import']) {
  const bytes=readFileSync(process.argv[2]+'/'+name+'.wasm');
  if (!WebAssembly.validate(bytes)) throw Error(name+' negative fixture is malformed');
}
JS
"$builder" "$tmp/valid.wasm" "$(sha256sum "$tmp/valid.wasm" | cut -d ' ' -f 1)" "$tmp/valid.cwasm" > "$tmp/valid.meta"
for reason in start table extra-memory import; do
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
echo 'AOT smoke: positive scalars, strict policy negatives and release-mode denial passed'
