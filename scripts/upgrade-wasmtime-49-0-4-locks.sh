#!/usr/bin/env bash
# One-time lockfile regeneration for the Wasmtime 49.0.4 security update.
# Run in the pinned patch branch on an authorized Rust-equipped workstation.
# DO NOT use this script as a substitute for clean exact-head native CI.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to regenerate both Cargo.lock files" >&2
  exit 127
fi
for crate in aot-host/precompile aot-host/run; do
  manifest="$crate/Cargo.toml"
  lockfile="$crate/Cargo.lock"
  echo "Updating $lockfile to Wasmtime 49.0.4"
  cargo update --manifest-path "$manifest" -p wasmtime --precise 49.0.4
  # Cargo itself must verify the generated graph against exact manifests.
  cargo metadata --manifest-path "$manifest" --locked --format-version=1 --no-deps >/dev/null
  if ! grep -A 2 -m 1 '^name = "wasmtime"$' "$lockfile" |
      grep -qx 'version = "49.0.4"'; then
    echo "$lockfile did not resolve Wasmtime 49.0.4" >&2
    exit 1
  fi
  if grep -q '^version = "49.0.3"$' "$lockfile"; then
    echo "$lockfile retains an affected Wasmtime-family 49.0.3 version" >&2
    exit 1
  fi
done
# Compiler-free runtime dependency invariant, independently of Wasmtime version.
runtime_tree="$(mktemp)"
trap 'rm -f "$runtime_tree"' EXIT
cargo tree --locked --manifest-path aot-host/run/Cargo.toml \
    --features insecure-dev-caller-pin > "$runtime_tree"
if grep -E 'wasmtime(-internal)?-(cranelift|winch)' "$runtime_tree"; then
  echo "AOT runtime unexpectedly gained an embedded compiler" >&2
  exit 1
fi
if ! grep -A 2 -m 1 '^name = "cranelift-codegen"$' \
    aot-host/precompile/Cargo.lock | grep -qx 'version = "0.136.4"'; then
  echo "trusted AOT precompiler did not resolve patched Cranelift 0.136.4" >&2
  exit 1
fi
echo "Lockfiles regenerated. Review git diff and COMMIT BOTH LOCKFILES."
echo "Only then run --locked Cargo/Node/AOT tests on an approved exact-head CI runner."
