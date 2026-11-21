#!/usr/bin/env bash
# Regenerate BOTH separate Cargo locks for the reviewed Wasmtime 49.0.5 patch.
# Must run on an authorized Rust-equipped checkout of the stacked draft branch.
# Never treat this local step as a native-CI or security-approval receipt.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is required to regenerate both Cargo.lock files" >&2
  exit 127
fi
if [[ "$(git rev-parse --show-toplevel)" != "$repo_dir" ]]; then
  echo "must run inside the exact repository checkout" >&2
  exit 1
fi
locks=(aot-host/precompile/Cargo.lock aot-host/run/Cargo.lock)
for manifest in aot-host/precompile/Cargo.toml aot-host/run/Cargo.toml; do
  if ! grep -Eq 'wasmtime=\{version="=49\.0\.5"' "$manifest"; then
    echo "$manifest does not pin Wasmtime =49.0.5" >&2
    exit 1
  fi
done
for lock in "${locks[@]}"; do
  # Reject symlinks/hardlinks before using Cargo to update the tracked files.
  if [[ ! -f "$lock" || -L "$lock" ]]; then
    echo "refusing non-regular or symlink Cargo lockfile: $lock" >&2
    exit 1
  fi
  lock_real="$(realpath -e -- "$lock")"
  if [[ "$lock_real" != "$repo_dir/$lock" ]]; then
    echo "refusing lockfile outside the repository's canonical path: $lock" >&2
    exit 1
  fi
  if [[ "$(stat -c %h -- "$lock")" != 1 ]]; then
    echo "refusing multiply-linked Cargo lockfile: $lock" >&2
    exit 1
  fi
  git ls-files --error-unmatch -- "$lock" >/dev/null
  if ! git diff --quiet -- "$lock" || ! git diff --cached --quiet -- "$lock"; then
    echo "refusing to replace pre-existing staged or unstaged edits to $lock" >&2
    exit 1
  fi
done
backup="$(mktemp -d)"
cp -- "${locks[0]}" "$backup/precompile.Cargo.lock"
cp -- "${locks[1]}" "$backup/run.Cargo.lock"
verified=0
cleanup() {
  status=$?
  trap - EXIT
  if [[ "$verified" != 1 ]]; then
    cp -- "$backup/precompile.Cargo.lock" "${locks[0]}"
    cp -- "$backup/run.Cargo.lock" "${locks[1]}"
    echo "lockfile update failed; both original lockfiles restored" >&2
  fi
  rm -rf -- "$backup"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for crate in aot-host/precompile aot-host/run; do
  manifest="$crate/Cargo.toml"
  lock="$crate/Cargo.lock"
  echo "Regenerating $lock with pinned Wasmtime 49.0.5"
  cargo update --manifest-path "$manifest" -p wasmtime --precise 49.0.5
  cargo metadata --manifest-path "$manifest" --locked --format-version=1 --no-deps >/dev/null
  if ! grep -A 2 -m 1 '^name = "wasmtime"$' "$lock" | grep -qx 'version = "49.0.5"'; then
    echo "$lock did not resolve the patched Wasmtime 49.0.5" >&2
    exit 1
  fi
  # All Wasmtime/Pulley packages in this pinned engine line must patch together.
  # Check every resolved package stanza, not merely the top-level crate.
  awk -F '"' '
    function check() {
      if ((name == "wasmtime" || name ~ /^wasmtime-/ || name ~ /^pulley-/) && version != "49.0.5") {
        print "unpatched Wasmtime/Pulley: " name " " version > "/dev/stderr"; bad=1
      }
      if (name ~ /^cranelift-/ && version != "0.136.5") {
        print "unpatched Cranelift: " name " " version > "/dev/stderr"; bad=1
      }
    }
    /^\[\[package\]\]$/ { check(); name=""; version=""; next }
    $1 == "name = " { name=$2 }
    $1 == "version = " { version=$2 }
    END { check(); if (bad) exit 1 }
  ' "$lock"
done
# Verify the runtime stays compiler-free, failing even if cargo tree itself fails.
rtree="$backup/runtime-tree.txt"
cargo tree --locked --manifest-path aot-host/run/Cargo.toml \
  --features insecure-dev-caller-pin > "$rtree"
if grep -E 'wasmtime(-internal)?-(cranelift|winch)' "$rtree"; then
  echo "AOT runtime unexpectedly gained an embedded compiler" >&2
  exit 1
fi
if ! grep -A 2 -m 1 '^name = "cranelift-codegen"$' \
    aot-host/precompile/Cargo.lock | grep -qx 'version = "0.136.5"'; then
  echo "trusted AOT precompiler did not resolve patched Cranelift 0.136.5" >&2
  exit 1
fi
verified=1
echo "Both Cargo lockfiles regenerated; inspect and commit their diffs."
echo "Native tests, protected CI and independent review are STILL REQUIRED."
