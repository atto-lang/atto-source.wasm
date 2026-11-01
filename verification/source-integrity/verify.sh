#!/usr/bin/env bash
# Check physical checkout against a pinned commit before any build step.
set -euo pipefail
fail() { printf 'SOURCE_INTEGRITY_FAIL: %s\n' "$*" >&2; exit 1; }
expected="${1:-}"
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || fail 'expected SHA must be 40 lowercase hex characters'
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail 'not a Git worktree'
root="$(git rev-parse --show-toplevel)"
[[ "$(pwd -P)" == "$(cd "$root" && pwd -P)" ]] || fail 'must run at repository root'
[[ "$(git rev-parse HEAD)" == "$expected" ]] || fail 'commit mismatch'
expected_tree="$(git rev-parse "${expected}^{tree}")"
[[ "$(git write-tree)" == "$expected_tree" ]] || fail 'staged tree differs from pinned commit'
git -c core.filemode=true diff --quiet --exit-code -- || fail 'unstaged modifications'
git diff --cached --quiet --exit-code HEAD -- || fail 'staged modifications'
if IFS= read -r -d '' stray < <(git ls-files --others --exclude-standard -z); then
  fail "untracked file: $stray"
fi
if IFS= read -r -d '' stray < <(git ls-files --others --ignored --exclude-standard -z); then
  fail "ignored file: $stray"
fi
while IFS= read -r -d '' entry; do
  metadata="${entry%%$'\t'*}"
  path="${entry#*$'\t'}"
  mode="${metadata%% *}"
  rest="${metadata#* }"
  blob="${rest%% *}"
  [[ "$mode" == '100644' || "$mode" == '100755' ]] || fail "forbidden Git entry mode $mode: $path"
  [[ -f "$path" && ! -L "$path" ]] || fail "missing or symlinked tracked file: $path"
  actual_blob="$(git hash-object --path="$path" -- "$path")" || fail "cannot hash tracked file: $path"
  [[ "$actual_blob" == "$blob" ]] || fail "physical file contents differ from pinned blob: $path"
  if [[ "$mode" == '100755' ]]; then
    [[ -x "$path" ]] || fail "executable bit missing: $path"
  else
    [[ ! -x "$path" ]] || fail "unexpected executable bit: $path"
  fi
done < <(git ls-files --stage -z)
printf 'SOURCE_INTEGRITY_OK commit=%s tree=%s\n' "$expected" "$expected_tree"
