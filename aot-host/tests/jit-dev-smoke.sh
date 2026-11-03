#!/usr/bin/env bash
# Development-only Wasmtime JIT validation. Does not prove an OS sandbox or
# compilation of AttoLang source actors. Requires Rust 1.96 + pinned lock.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
crate=aot-host/precompile/Cargo.toml
cargo build --locked --manifest-path "$crate" --bin oreslang-jit-dev
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 42 }\n' |
  clang --target=wasm32 -x ir -O0 -nostdlib -Wl,--no-entry -Wl,--export=main \
    -Wl,--initial-memory=131072 -Wl,--max-memory=131072 -o "$tmp/42.wasm" -
cli="$root/aot-host/precompile/target/debug/oreslang-jit-dev"
pin="$(sha256sum "$tmp/42.wasm" | cut -d ' ' -f 1)"
if "$cli" "$tmp/42.wasm" "$pin" > "$tmp/no-feature.out" 2> "$tmp/no-feature.err"; then
  echo 'default JIT binary executed without development feature' >&2; exit 1
fi
grep -q 'Wasmtime JIT execution disabled' "$tmp/no-feature.err"
cargo build --locked --manifest-path "$crate" --bin oreslang-jit-dev --features insecure-dev-jit
actual="$("$cli" "$tmp/42.wasm" "$pin")"
[[ "$actual" == 42 ]] || { echo 'JIT returned incorrect scalar' >&2; exit 1; }
if "$cli" "$tmp/42.wasm" "$(printf '0%.0s' {1..64})" > /dev/null 2>&1; then
  echo 'incorrect digest admitted' >&2; exit 1
fi
cat > "$tmp/loop.ll" <<'LLVM'
target triple = "wasm32-unknown-unknown"
define i64 @main() {
entry:
 br label %spin
spin:
 br label %spin
}
LLVM
clang --target=wasm32 -x ir -O0 -nostdlib -Wl,--no-entry -Wl,--export=main \
  -Wl,--initial-memory=131072 -Wl,--max-memory=131072 \
  -o "$tmp/loop.wasm" "$tmp/loop.ll"
set +e
timeout 5s "$cli" "$tmp/loop.wasm" "$(sha256sum "$tmp/loop.wasm" | cut -d ' ' -f 1)" 10000 \
  > "$tmp/loop.out" 2> "$tmp/loop.err"
status=$?
set -e
if [[ "$status" == 0 || "$status" == 124 || "$status" == 137 ]]; then
  echo 'JIT loop failed to exhaust fuel safely' >&2; exit 1
fi
# Test real Wasm import denial with no imported function silently fulfilled.
cat > "$tmp/import.ll" <<'LLVM'
target triple = "wasm32-unknown-unknown"
declare i64 @forbidden()
define i64 @main() { %v = call i64 @forbidden()
 ret i64 %v }
LLVM
clang --target=wasm32 -x ir -O0 -nostdlib -Wl,--no-entry -Wl,--export=main \
  -Wl,--allow-undefined -Wl,--initial-memory=131072 -Wl,--max-memory=131072 \
  -o "$tmp/import.wasm" "$tmp/import.ll"
if "$cli" "$tmp/import.wasm" "$(sha256sum "$tmp/import.wasm" | cut -d ' ' -f 1)" > /dev/null 2>&1; then
  echo 'JIT admitted forbidden import' >&2; exit 1
fi
# Release with forced debug assertions MUST STILL refuse developer JIT.
cargo build --release --locked --manifest-path "$crate" --bin oreslang-jit-dev \
  --features insecure-dev-jit --config profile.release.debug-assertions=true
release_cli="$root/aot-host/precompile/target/release/oreslang-jit-dev"
if "$release_cli" "$tmp/42.wasm" "$pin" > "$tmp/release.out" 2> "$tmp/release.err"; then
  echo 'release JIT binary admitted caller-controlled Wasm' >&2; exit 1
fi
grep -q 'Wasmtime JIT execution disabled' "$tmp/release.err"
echo 'development-only Wasmtime JIT: scalar, fuel, import, pin, and release-denial checks passed'
