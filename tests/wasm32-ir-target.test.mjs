import test from 'node:test';
import assert from 'node:assert/strict';
import {assertWasm32IrTarget} from '../scripts/wasm32-ir-target.mjs';
const valid = 'target triple = "wasm32-unknown-unknown"\ndefine i64 @main() { ret i64 42 }\n';
test('actual wasm32 triple is admitted', () => {
  assert.equal(assertWasm32IrTarget(valid), true);
  assert.equal(assertWasm32IrTarget('source_filename = "guest"\r\ntarget triple = "wasm32-unknown-unknown"\r\n'),true);
});
test('comments, string literals and native triples cannot authorize a portable artifact', () => {
  for (const ir of [
    '; target triple = "wasm32-unknown-unknown"\n',
    '; target triple = "wasm32-unknown-unknown"\ntarget triple = "x86_64-unknown-linux-gnu"\n',
    'source_filename = "target triple = wasm32-unknown-unknown"\n',
    'target triple = "x86_64-unknown-linux-gnu"\n',
    'define i64 @main() { ret i64 42 }\n',
    'target triple = "wasm32-unknown-unknown" ; appended data\n',
    valid + 'target triple = "wasm32-unknown-unknown"\n'
  ]) assert.throws(() => assertWasm32IrTarget(ir), /wasm32 target-marked IR/);
});
test('compiler IR must remain bounded', () => {
  assert.throws(() => assertWasm32IrTarget('x'.repeat(2*1024*1024+1)), /exceeds 2 MiB/);
});
