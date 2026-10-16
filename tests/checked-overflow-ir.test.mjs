import test from "node:test";
import assert from "node:assert/strict";
import {assertCheckedOverflowIr,isSignedI64OverflowDiagnostic} from "../scripts/checked-overflow-ir.mjs";

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

test("checked intrinsics in an uncalled helper cannot certify main",()=>{
  const decoy=valid.replace("define i64 @main() {","define i64 @decoy() {")+
    "define i64 @main() {\nentry:\n  ret i64 42\n}\n";
  assert.throws(()=>assertCheckedOverflowIr(decoy,"sadd"),/required signed-i64/);
  assert.throws(()=>assertCheckedOverflowIr(valid+valid,
    "sadd"),/exactly one i64 guest main body/);
});


test("only an i64-specific compiler diagnostic qualifies as overflow refusal",()=>{
  for (const error of [
    "command failed (/tmp/compiler-exact): oreslang-llvmc: checked i64 overflow",
    "oreslang-llvmc: signed integer out of range",
    "oreslang-llvmc: invalid i64 literal",
    "oreslang-llvmc: arithmetic out of bounds"
  ]) assert.equal(isSignedI64OverflowDiagnostic(Error(error)),true,error);
  for (const unrelated of [
    "command failed (/tmp/compiler-exact): oreslang-llvmc: input file missing",
    "oreslang-llvmc: failed to open overflow.ores (not found)",
    "oreslang-llvmc: unknown compiler flag",
    "oreslang-llvmc: wasm32 target unsupported",
    "clang: arithmetic overflow",
    "worker failed: wasm runtime trap: unreachable",
    "oreslang-llvmc: invalid syntax\nother tool: overflow"
  ]) assert.equal(isSignedI64OverflowDiagnostic(Error(unrelated)),false,unrelated);
});
