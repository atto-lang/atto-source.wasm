#!/usr/bin/env bash
# Source-free adversarial tests; never claim compiler/native guest coverage.
set -euo pipefail
verify="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify.sh"
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
cd "$work"
git init -q -b main
git config user.name 'Oreslang Audit Fixture'
git config user.email 'audit@example.invalid'
printf 'tracked\n' > tracked.txt
printf '*.cache\n' > .gitignore
git add tracked.txt .gitignore
git commit -qm 'fixture'
head="$(git rev-parse HEAD)"
pass=0
reject() {
  if bash "$verify" "$head" >/dev/null 2>&1; then
    echo "FAIL: $1 was admitted" >&2
    exit 1
  fi
  pass=$((pass+1))
  echo "PASS: $1 rejected"
}
bash "$verify" "$head" >/dev/null
pass=$((pass+1))
reject_wrong="0000000000000000000000000000000000000000"
original="$head"
head="$reject_wrong"
reject 'wrong commit'
head="$original"
printf 'changed\n' > tracked.txt
reject 'unstaged file modification'
git reset -q --hard HEAD
printf 'staged\n' > tracked.txt
git add tracked.txt
reject 'staged file modification'
git reset -q --hard HEAD
printf 'untracked\n' > extra.txt
reject 'untracked file'
rm extra.txt
printf 'ignored\n' > temp.cache
reject 'ignored file'
rm temp.cache
chmod +x tracked.txt
reject 'physical executable bit change'
chmod -x tracked.txt
git update-index --skip-worktree tracked.txt
printf 'hidden changed bytes\n' > tracked.txt
reject 'skip-worktree hidden content mutation'
git update-index --no-skip-worktree tracked.txt
git reset -q --hard HEAD
rm tracked.txt
reject 'missing tracked file'
git reset -q --hard HEAD
ln -s tracked.txt alias.txt
git add alias.txt
git commit -qm 'tracked symlink negative fixture'
head="$(git rev-parse HEAD)"
reject 'tracked symlink'
printf 'PASS: %s source-integrity self-checks (1 positive, %s negative)\n' "$pass" "$((pass-1))"
