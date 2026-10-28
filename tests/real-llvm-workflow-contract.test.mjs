import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const workflow = readFileSync(fileURLToPath(
  new URL('../.github/workflows/real-llvm.yml', import.meta.url)), 'utf8');

test('manual real-actor gate never checks out cross-repository source with a token', () => {
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /ORE.*READ_TOKEN/);
  assert.doesNotMatch(workflow, /repository:\s*ores-truffle-oreslang\/oreslang-source\.llvm/);
  assert.doesNotMatch(workflow, /llvm-source\//);
  assert.match(workflow, /persist-credentials:\s*false/);
});

test('real-actor gate requires protected source-local disposable runner and immutable repo ID', () => {
  assert.match(workflow, /runs-on:\s*\[self-hosted, linux, x64, oreslang-private-ephemeral\]/);
  assert.match(workflow, /github\.ref_protected/);
  assert.match(workflow, /test "\$PROTECTED_REF" = 'true'/);
  assert.match(workflow, /test "\$REPOSITORY_ID" = '1419858954'/);
  assert.doesNotMatch(workflow, /runs-on:\s*ubuntu-/);
});

test('caller may not self-approve a selected source revision or compiler digest', () => {
  assert.match(workflow, /vars\.ORESLANG_WASM_REAL_ACTOR_APPROVED_HEAD/);
  assert.match(workflow, /vars\.ORESLANG_WASM_REAL_ACTOR_APPROVED_TREE/);
  assert.match(workflow, /vars\.ORESLANG_LLVM_REAL_ACTOR_COMPILER_SHA256/);
  assert.match(workflow, /test "\$REQUESTED_WASM_SHA" = "\$APPROVED_WASM_SHA"/);
  assert.match(workflow, /test "\$APPROVED_LLVM_SHA" = "\$ORESLANG_LLVM_SOURCE_SHA"/);
  assert.match(workflow, /test "\$\(git rev-parse 'HEAD\^\{tree\}'\)" = "\$APPROVED_WASM_TREE"/);
  assert.match(workflow, /sha256sum "\$ORESLANG_LLVM_COMPILER"/);
});

test('admission executes before checkout and tests require pinned guest execution', () => {
  const admission = workflow.indexOf('Enforce independent approval');
  const checkout = workflow.indexOf('Check out exact reviewed WASM source');
  const suite = workflow.indexOf('npm test');
  const guests = workflow.indexOf('npm run test:real-pooled-actors');
  const recheck = workflow.indexOf('Recheck exact source and compiler');
  assert.ok(0 <= admission && admission < checkout);
  assert.ok(checkout < suite && suite < guests && guests < recheck);
  assert.match(workflow, /npm run test:real-compiler/);
  assert.match(workflow, /test -z "\$\(git status --porcelain\)"/);
});
