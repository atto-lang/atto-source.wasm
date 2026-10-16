import test from "node:test";
import assert from "node:assert/strict";
import {assertCheckedOverflowIr} from "../scripts/checked-overflow-ir.mjs";

// Independent hand-authored LLVM fixture; no private Oreslang source or stub
// compiler. These checks only establish that the IR admission logic rejects
// dangling or unrelated trap paths, not that Oreslang emits compliant IR.
const valid = [
  'target triple = "wasm32-unknown-unknown"',
  'declare { i64, i1 } @llvm.sadd.with.overflow.i64(i64, i64)',
  'declare void @llvm.trap()',
  'define i64 @main() {',
  'entry:',
  '  %i64.checked.pair = call { i64, i1 } @llvm.sadd.with.overflow.i64(i64 1, i64 2)',
  '  %i64.checked.value = extractvalue { i64, i1 } %i64.checked.pair, 0',
  '  %i64.checked.overflow = extractvalue { i64, i1 } %i64.checked.pair, 1',
  '  br i1 %i64.checked.overflow, label %i64.overflow.trap, label %i64.checked.continue',
  'i64.overflow.trap: ; preds = %entry',
  '  call void @llvm.trap()',
  '  unreachable',
  'i64.checked.continue: ; preds = %entry',
  '  ret i64 %i64.checked.value',
  '}'
].join("\n")+"\n";

test("paired signed overflow SSA flag -> guarded llvm.trap admitted",()=>{
  assert.doesNotThrow(()=>assertCheckedOverflowIr(valid,"sadd"));
});

test("signed overflow witness rejects wrong operation, no triple or missing trap",()=>{
  assert.throws(()=>assertCheckedOverflowIr(valid,"smul"),/required signed-i64/);
  assert.throws(()=>assertCheckedOverflowIr(valid.replace(
    'target triple = "wasm32-unknown-unknown"','; target triple = "wasm32-unknown-unknown"'),"sadd"),/target triple/);
  assert.throws(()=>assertCheckedOverflowIr(valid.replace(
    'call void @llvm.trap()', 'call void @other()'),"sadd"),/conditional trap/);
});

test("unrelated and unguarded traps cannot impersonate checked overflow",()=>{
  assert.throws(()=>assertCheckedOverflowIr(valid.replace(
    '  ret i64 %i64.checked.value',
    '  call void @llvm.trap()\n  unreachable\n  ret i64 %i64.checked.value'),"sadd"),/conditional trap/);
  assert.throws(()=>assertCheckedOverflowIr(valid.replace(
    'br i1 %i64.checked.overflow',
    'br i1 %unrelated.condition'),"sadd"),/conditional trap/);
  assert.throws(()=>assertCheckedOverflowIr(valid.replace(
    '  br i1 %i64.checked.overflow',
    '  ; br i1 %i64.checked.overflow'),"sadd"),/conditional trap/,
    "commented-out branch must not count as a real overflow guard");
  const wrongOperationIsUnused=valid.replace(
    '  br i1 %i64.checked.overflow',
    '  %unused = call { i64, i1 } @llvm.smul.with.overflow.i64(i64 2, i64 3)\n  br i1 %i64.checked.overflow');
  assert.throws(()=>assertCheckedOverflowIr(wrongOperationIsUnused,"smul"),
    /operation-specific/);

  assert.throws(()=>assertCheckedOverflowIr(valid.replace(
    'extractvalue { i64, i1 } %i64.checked.pair, 1',
    'extractvalue { i64, i1 } %unrelated.pair, 1'),"sadd"),/conditional trap/);
});
