#!/usr/bin/env bash
# Build only from an already-authorized, locally present LLVM checkout.
# Never clone/fetch private source, mirror it, or accept an arbitrary HEAD.\n# Commit/tree below are an integration CANDIDATE, not transfer authorization.
set -euo pipefail

PINNED_LLVM_SOURCE_COMMIT=a79156b74098c368763ee2c6843a65126e3051bf
PINNED_LLVM_SOURCE_TREE=43f8bda51bae2deb7747d73962be3ef6a3534628

die() { echo "NOT_EXECUTED: pinned LLVM build: $*" >&2; exit 1; }
mode="${1:-build}"
[[ "$mode" == build || "$mode" == --preflight ]] || die 'unknown compiler build mode'
source_dir="${ORESLANG_LLVM_SOURCE_DIR:-}"
[[ "$source_dir" == /* && "$source_dir" != *$'\n'* && -d "$source_dir" && ! -L "$source_dir" ]] ||
  die 'authorized absolute non-symlink ORESLANG_LLVM_SOURCE_DIR required'
[[ "$(realpath -e "$source_dir")" == "$source_dir" ]] ||
  die 'LLVM source directory must be canonical'
[[ "$(git -C "$source_dir" rev-parse --show-toplevel 2>/dev/null)" == "$source_dir" ]] ||
  die 'LLVM source directory is not the Git repository root'
[[ "$(git -C "$source_dir" rev-parse HEAD)" == "$PINNED_LLVM_SOURCE_COMMIT" ]] ||
  die 'LLVM commit is not the reviewed full SHA'
[[ "$(git -C "$source_dir" rev-parse 'HEAD^{tree}')" == "$PINNED_LLVM_SOURCE_TREE" ]] ||
  die 'LLVM source Git tree differs from approved pin'
tracked="$(git -C "$source_dir" status --porcelain --untracked-files=no)" ||
  die 'LLVM tracked source status query failed'
[[ -z "$tracked" ]] || die 'LLVM tracked source is dirty'
[[ ! -e "$source_dir/build" && ! -L "$source_dir/build" ]] ||
  die 'refusing preexisting compiler build tree before source admission'
untracked="$(git -C "$source_dir" ls-files --others --exclude-standard)" ||
  die 'LLVM untracked-file audit failed'
[[ -z "$untracked" ]] || die 'LLVM checkout contains untracked source files'
ignored="$(git -C "$source_dir" ls-files --others --ignored --exclude-standard)" ||
  die 'LLVM ignored-file audit failed'
[[ -z "$ignored" ]] || die 'LLVM checkout contains ignored source files'
[[ -f "$source_dir/tests/verify_compiler_receipt.py" ]] ||
  die 'LLVM source-local receipt verifier missing'

if [[ "$mode" == --preflight ]]; then
  echo "PINNED_LLVM_SOURCE_ADMITTED source=$PINNED_LLVM_SOURCE_COMMIT tree=$PINNED_LLVM_SOURCE_TREE"
  exit 0
fi

command -v cmake >/dev/null || die 'CMake unavailable'
command -v python3 >/dev/null || die 'Python unavailable'
command -v git >/dev/null || die 'Git unavailable'
compiler="$source_dir/build/oreslang-llvmc"
[[ ! -e "$source_dir/build" && ! -L "$source_dir/build" ]] ||
  die 'refusing preexisting build directory or symbolic link'
[[ ! -e "$compiler" && ! -L "$compiler" ]] ||
  die 'refusing preexisting compiler build output'
cmake -S "$source_dir" -B "$source_dir/build" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
cmake --build "$source_dir/build" --target oreslang-llvmc --parallel 2
[[ -f "$compiler" && -x "$compiler" && ! -L "$compiler" ]] ||
  die 'expected source-built LLVM executable missing'
receipt_dir="${RUNNER_TEMP:-}"
[[ "$receipt_dir" == /* && -d "$receipt_dir" && ! -L "$receipt_dir" ]] ||
  die 'private RUNNER_TEMP directory required'
receipt="$receipt_dir/oreslang-llvm-compiler-receipt.json"
[[ ! -e "$receipt" && ! -L "$receipt" ]] || die 'refusing to reuse a receipt'
python3 "$source_dir/tests/verify_compiler_receipt.py" capture \
  --source "$source_dir" --compiler "$compiler" \
  --expected-head "$PINNED_LLVM_SOURCE_COMMIT" --receipt "$receipt"
python3 "$source_dir/tests/verify_compiler_receipt.py" verify \
  --source "$source_dir" --compiler "$compiler" \
  --expected-head "$PINNED_LLVM_SOURCE_COMMIT" --receipt "$receipt"
digest="$(sha256sum "$compiler" | cut -d' ' -f1)"
[[ "$digest" =~ ^[a-f0-9]{64}$ ]] || die 'compiler digest unavailable'

# All values below come from the already-pinned local checkout and freshly
# verified receipt, never from an untrusted pull-request-supplied manifest.
if [[ -n "${GITHUB_ENV:-}" ]]; then
  [[ -f "$GITHUB_ENV" && ! -L "$GITHUB_ENV" ]] || die 'unsafe GitHub environment file'
  {
    printf 'ORESLANG_LLVM_COMPILER=%s\n' "$compiler"
    printf 'ORESLANG_LLVM_COMPILER_SHA256=%s\n' "$digest"
    printf 'ORESLANG_LLVM_SOURCE_SHA=%s\n' "$PINNED_LLVM_SOURCE_COMMIT"
    printf 'ORESLANG_LLVM_SOURCE_TREE=%s\n' "$PINNED_LLVM_SOURCE_TREE"
    printf 'ORESLANG_LLVM_SOURCE_DIR=%s\n' "$source_dir"
    printf 'ORESLANG_LLVM_COMPILER_RECEIPT=%s\n' "$receipt"
  } >> "$GITHUB_ENV"
fi
echo "PINNED_LLVM_COMPILER_BUILT source=$PINNED_LLVM_SOURCE_COMMIT tree=$PINNED_LLVM_SOURCE_TREE digest=$digest"
echo "STATUS: byte/source receipt verified; trusted runner authorization and guest execution are separate gates"
