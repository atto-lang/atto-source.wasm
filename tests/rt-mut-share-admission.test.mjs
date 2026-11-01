import test from "node:test";
import assert from "node:assert/strict";
import {assertNativeMutShareDenial} from "../scripts/rt-mut-share-admission.mjs";

const valid = "command failed (/tmp/private/compiler-exact): oreslang-llvmc: native rt mut share requires verified SharedMutex<T> capability, guarded lowering and allocation-domain proof";
test("guarded-sharing rejection requires the exact compiler and diagnostic", () => {
  assert.equal(assertNativeMutShareDenial(new Error(valid)), true);
  assert.equal(assertNativeMutShareDenial({message: valid, signal: null}), true);
});
test("host failure, generic parser error and a substituted compiler fail closed", () => {
  for (const message of [
    "spawn /tmp/private/compiler-exact ENOENT",
    "command failed (/tmp/private/clang): oreslang-llvmc: native rt mut share requires verified SharedMutex<T> capability",
    "command failed (/tmp/private/compiler-exact): oreslang-llvmc: unexpected token at byte 3",
    "command failed (/tmp/private/compiler-exact): missing wasm linker",
    "command failed (/tmp/private/compiler-exact): oreslang-llvmc: native rt mut share requires verified SharedMutex<T> capability\nSIGSEGV",
    valid + "\ndefine i64 @main() {",
    valid + "\n; ModuleID = fake",
    valid + "\ntarget triple = fake"
  ]) assert.throws(() => assertNativeMutShareDenial({message}), undefined, message);
  assert.throws(() => assertNativeMutShareDenial({message:valid,signal:"SIGKILL"}));
});
