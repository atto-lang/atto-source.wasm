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
# A clean text normalization can conceal modified working bytes from git diff
# and from git hash-object --path. The physical-byte gate must reject it.
git reset -q --hard HEAD^
printf '*.txt text\n' > .gitattributes
git add .gitattributes
git commit -qm 'CRLF normalization adversarial fixture'
head="$(git rev-parse HEAD)"
printf 'tracked\r\n' > tracked.txt
reject 'CRLF text-normalization laundering'
git reset -q --hard HEAD
# Directory symlinks may escape the source checkout even if the leaf is regular.
mkdir -p nested
printf 'nested source\n' > nested/child.txt
git add nested/child.txt
git commit -qm 'nested tracked-file fixture'
head="$(git rev-parse HEAD)"
outside="$(mktemp -d)"
cp nested/child.txt "$outside/child.txt"
rm -rf nested
ln -s "$outside" nested
reject 'tracked directory symlink escape'
rm nested
rm -rf "$outside"
printf 'PASS: %s source-integrity self-checks (1 positive, %s negative)\n' "$pass" "$((pass-1))"
