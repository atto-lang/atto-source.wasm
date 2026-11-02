import test from "node:test";
import assert from "node:assert/strict";
import {assertNativeMutShareDenial} from "../scripts/rt-mut-share-admission.mjs";

const valid = "command failed (/tmp/private/compiler-exact): oreslang-llvmc: native rt mut share requires verified SharedMutex<T> capability, guarded lowering and allocation-domain proof";
const evidence = {
  message:valid, status:1, signal:null, stdout:"",
  stderr:"oreslang-llvmc: native rt mut share requires verified SharedMutex<T> capability, guarded lowering and allocation-domain proof"
};
test("guarded-sharing rejection requires the exact compiler and diagnostic", () => {
  assert.equal(assertNativeMutShareDenial(evidence), true);
  assert.equal(assertNativeMutShareDenial({...evidence,status:2}), true);
  assert.throws(() => assertNativeMutShareDenial(new Error(valid)),
    undefined, "message-only Error is not real compiler evidence");
  assert.throws(() => assertNativeMutShareDenial({message:valid,signal:null}),
    undefined, "missing process fields are not compiler evidence");
  assert.throws(() => assertNativeMutShareDenial({...evidence,stderr:"unrelated parser error"}),
    undefined, "compiler-owned stderr is required");
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
    valid + "\ntarget triple = fake",
    valid + "\nsource_filename = pretend",
    valid + "\ndeclare i32 @escaped()",
    valid + "\nattributes #0 = { nounwind }",
    valid + "\nSegmentation fault (core dumped)",
    valid + "\nLLVM ERROR: malformed IR",
    valid + "\nThread 'main' Panicked At src/compiler.rs:9",
    valid + "\nCommand Not Found",
    valid + "\nSTACK OVERFLOW",
    valid.replace(", guarded lowering and allocation-domain proof", "")
  ]) assert.throws(() => assertNativeMutShareDenial({...evidence,message}), undefined, message);
  // Human-facing messages are truncated to 4 KiB by the spawn bridge.
  // Forged rejection bytes must never conceal later stderr IR or crashes.
  for (const tail of ["\ndeclare i64 @hidden(i64)", "\nSegmentation fault (core dumped)"]) {
    assert.throws(() => assertNativeMutShareDenial({
      ...evidence,
      stderr:evidence.stderr + "x".repeat(5000) + tail
    }), undefined, "full stderr must be inspected beyond the truncated error summary");
  }
  for (const stdout of ["define i64 @main() {", " ", "; partial source module"]) {
    assert.throws(() => assertNativeMutShareDenial({...evidence,stdout}),
      undefined, "failed compiler stdout is not a valid source rejection");
  }
  assert.equal(assertNativeMutShareDenial(evidence),true);
  assert.throws(() => assertNativeMutShareDenial({...evidence,signal:"SIGKILL"}));
  for (const failure of [
    {code:"ENOENT"}, {errno:-2}, {syscall:"spawn"}, {cause:new Error("host failure")},
    {status:0}, {status:NaN}, {status:-1}
  ]) assert.throws(() => assertNativeMutShareDenial({...evidence,...failure}),
    undefined, "host failure metadata and successful status must not count as compiler denial");
});

test("mixed diagnostics and spoofed trailing errors are never ownership proof", () => {
  // A native compiler may print a plausible capability denial and then
  // report the actual failure. Only a single compiler-owned denial counts.
  for (const stderr of [
    evidence.stderr + "\nerror: unrelated parser failure",
    evidence.stderr + "\r\nusage: compiler-exact [options]",
    evidence.stderr + "\n" + evidence.stderr,
    "warning: fallback compiler\n" + evidence.stderr,
    evidence.stderr + "\nsource_filename = 'partial.ll'",
    evidence.stderr + "\nerror: missing input"
  ]) {
    assert.throws(() => assertNativeMutShareDenial({...evidence, stderr}),
      undefined, "mixed failure incorrectly treated as native ownership rejection");
  }
  assert.equal(assertNativeMutShareDenial({
    ...evidence, stderr:evidence.stderr + "; refusing unsynchronized alias\n"
  }), true);
});
