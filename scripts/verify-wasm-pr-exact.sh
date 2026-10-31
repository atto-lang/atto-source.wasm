#!/usr/bin/env bash
# Source-local verification; never mirrors source or uploads outputs.
set -Eeuo pipefail
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo 'Usage: verify-wasm-pr-exact.sh EXPECTED_COMMIT_SHA EXPECTED_TREE_SHA [--node-only|--require-real]' >&2
  exit 64
fi
expected_head="$1"; expected_tree="$2"; mode="${3:---node-only}"
[[ "$expected_head" =~ ^[0-9a-f]{40}$ && "$expected_tree" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected hashes must be 40 lower-case hex characters' >&2; exit 64; }
[[ "$mode" == '--node-only' || "$mode" == '--require-real' ]] || { echo 'Unsupported mode' >&2; exit 64; }
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ "$(git rev-parse --is-inside-work-tree)" == 'true' ]] || { echo 'Not a Git worktree' >&2; exit 65; }
actual_head="$(git rev-parse HEAD)"; actual_tree="$(git rev-parse 'HEAD^{tree}')"
[[ "$actual_head" == "$expected_head" && "$actual_tree" == "$expected_tree" ]] || {
  printf 'Revision mismatch: head=%s tree=%s\n' "$actual_head" "$actual_tree" >&2
  exit 65
}
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || { echo 'Worktree is dirty; refusing to attribute results to immutable head' >&2; exit 65; }
command -v node >/dev/null && command -v npm >/dev/null || { echo 'Node and npm required' >&2; exit 69; }
node -e 'if(Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || { echo 'Node 22+ required' >&2; exit 69; }
if [[ "$mode" == '--require-real' ]]; then
  # These are identities, not credentials; the real verifiers validate the SHA-256 bytes.
  for var in ORESLANG_LLVM_COMPILER ORESLANG_LLVM_COMPILER_SHA256 ORESLANG_LLVM_SOURCE_SHA \
             ORESLANG_AOT_BUILDER ORESLANG_AOT_BUILDER_SHA256 \
             ORESLANG_AOT_DEV_RUNNER ORESLANG_AOT_DEV_RUNNER_SHA256; do
    [[ -n "${!var:-}" ]] || { echo "Required compiler/AOT tool identity missing: $var" >&2; exit 69; }
  done
fi
results="$(mktemp -d "${TMPDIR:-/tmp}/oreslang-wasm-exact.XXXXXXXX")"
node_status='NOT_EXECUTED'; compiler_status='NOT_EXECUTED'; aot_status='NOT_EXECUTED'
finish() {
  local original_exit=$?
  trap - EXIT
  if [[ "$original_exit" -eq 0 && ( "$(git rev-parse HEAD)" != "$expected_head" || "$(git rev-parse 'HEAD^{tree}')" != "$expected_tree" || -n "$(git status --porcelain --untracked-files=normal)" ) ]]; then
    original_exit=65
    echo 'Source changed during verification; refusing passing result' >&2
  fi
  RESULT_HEAD="$actual_head" RESULT_TREE="$actual_tree" RESULT_NODE="$node_status" \
    RESULT_COMPILER="$compiler_status" RESULT_AOT="$aot_status" \
    RESULT_MODE="$mode" RESULT_CODE="$original_exit" RESULT_LOG="$results/npm-test.log" node -e '
      const fs = require("node:fs");
      const e = process.env;
      const output = fs.existsSync(e.RESULT_LOG) ? fs.readFileSync(e.RESULT_LOG,"utf8") : "";
      const counts = Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|skipped|todo) (\d+)$/gm)].map(m => [m[1],Number(m[2])]));
      console.log(JSON.stringify({schema:1,commit:e.RESULT_HEAD,root_tree:e.RESULT_TREE,
        node_tests:e.RESULT_NODE,real_compiler:e.RESULT_COMPILER,
        real_aot:e.RESULT_AOT,mode:e.RESULT_MODE,exit_code:Number(e.RESULT_CODE),
        node_version:process.version,test_counts:counts},null,2));
    ' > "$results/manifest.json"
  printf '\nVerification records: %s\n' "$results"
  exit "$original_exit"
}
trap finish EXIT
if npm test 2>&1 | tee "$results/npm-test.log"; then
  if node -e 'const s=require("node:fs").readFileSync(process.argv[1],"utf8"); const n=Object.fromEntries([...s.matchAll(/^# (tests|pass|fail|skipped|todo) (\d+)$/gm)].map(m=>[m[1],Number(m[2])])); if(!(n.tests>0) || n.fail!==0 || n.pass+n.skipped+(n.todo||0)!==n.tests) process.exit(1)' "$results/npm-test.log"; then
    node_status='PASS'
  else
    node_status='INVALID_TEST_SUMMARY'; exit 1
  fi
else
  node_status='FAIL'
  exit 1
fi
if [[ "$mode" == '--require-real' ]]; then
  if npm run test:real-compiler 2>&1 | tee "$results/real-compiler.log"; then
    compiler_status='PASS'
  else
    compiler_status='FAIL'; exit 1
  fi
  if npm run test:real-aot 2>&1 | tee "$results/real-aot.log"; then
    aot_status='PASS'
  else
    aot_status='FAIL'; exit 1
  fi
fi
