#!/usr/bin/env bash
# Shared AttoLang dispatch fixture admission only: NOT a compiler/guest test.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
: "${EXPECTED_HEAD:?set immutable checked-out 40-hex Git commit}"
[[ "$EXPECTED_HEAD" =~ ^[0-9a-f]{40}$ ]]
test "$(git rev-parse --verify HEAD)" = "$EXPECTED_HEAD"
base="contracts/dispatch-v1"
while IFS=$'\t' read -r name expected; do
  test -n "$name" || continue
  file="$base/$name"
  test -f "$file" && test ! -L "$file"
  checked="$(git hash-object -- "$file")"
  tracked="$(git rev-parse "HEAD:$file")"
  test "$checked" = "$expected" && test "$tracked" = "$expected" || {
    echo "DISPATCH_CORPUS_DRIFT: $name changed or untracked" >&2
    exit 1
  }
  printf 'DISPATCH_CORPUS_BLOB_V1|file=%s|sha=%s\n' "$file" "$expected"
done <<'BLOBS'
cases.tsv	f4f692a84be0ae08c0a0655278076fecf508b4af
direct_call_42.atto	f827bef2b2d4dea73b249ca7c9071224bbb06a2d
instance_call_42.atto	c886c3d69604563ced898f7bea49c757a20ef9b2
static_qualified_42.atto	b822f5a2ccb8fbe693fc4ad8ee4ea1b0289fce9a
virtual_override_121020.atto	e236da736a06b1a3d9c9e7b0ee43bdda99a073f6
wrong_arity_reject.atto	939809a4bf345867364d56ad3071d97bec268e65
BLOBS
echo "DISPATCH_CORPUS_SOURCE_ONLY_PASS|head=$EXPECTED_HEAD|fixtures=5|manifest=1|guest_execution=NOT_EXECUTED"
