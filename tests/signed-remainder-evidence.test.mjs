import test from "node:test";
import assert from "node:assert/strict";
import {isNativeSemanticRejection, isExecutedWasmOverflowTrap} from "../scripts/signed-remainder-evidence.mjs";

const semantic = /nonzero signed integer literal divisor/;
const diagnosed = message => Error("command failed (/tmp/private/compiler-exact): oreslang-llvmc: " + message);

test("diagnosed compiler source rejection is distinct from infrastructure failure", () => {
  assert.equal(isNativeSemanticRejection(
    diagnosed("native remainder requires a nonzero signed integer literal divisor"), semantic), true);
  for (const error of [
    Error("command failed (/tmp/clang): oreslang-llvmc: native remainder requires a nonzero signed integer literal divisor"),
    Error("missing ORESLANG_LLVM_COMPILER"),
    Error("command failed (/tmp/private/compiler-exact): clang: linker failed"),
    diagnosed("unknown option: native remainder requires a nonzero signed integer literal divisor"),
    diagnosed("native remainder requires a signed integer literal divisor"),
    Error("command failed (/tmp/private/compiler-exact): fake success"),
    {message: null},
  ]) assert.equal(isNativeSemanticRejection(error, semantic), false);
  assert.equal(isNativeSemanticRejection(diagnosed("native remainder requires a nonzero signed integer literal divisor"), /signed/g), false);
});

test("only an observed isolated WASM arithmetic trap counts as trap", () => {
  for (const message of ["guest rejected or failed: unreachable", "guest rejected or failed: integer overflow"])
    assert.equal(isExecutedWasmOverflowTrap(Error(message)), true);
  for (const message of [
    "guest execution deadline exceeded", "guest worker failure: timeout",
    "guest rejected or failed: invalid Wasm", "guest rejected or failed: missing entry",
    "guest rejected or failed: unreachable, but a linker failed",
    "guest worker exited before result: 1", "unreachable"
  ]) assert.equal(isExecutedWasmOverflowTrap(Error(message)), false);
});
