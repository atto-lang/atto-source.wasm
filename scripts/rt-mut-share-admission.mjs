import assert from "node:assert/strict";

// A rejected guest must reach the reviewed compiler image and fail because of
// the guarded-sharing contract. Host errors and generic parser failures do not
// establish fail-closed source admission.
export function assertNativeMutShareDenial(error) {
  assert.ok(error && typeof error.message === "string",
    "rejection requires a structured compiler error");
  assert.match(error.message,
    /^command failed \([^)]+[\\/]compiler-exact\): oreslang-llvmc: native rt mut share requires verified SharedMutex<T> capability/,
    "expected the exact staged native compiler and guarded-sharing diagnostic");
  assert.doesNotMatch(error.message,
    /spawn |ENOENT|EACCES|ETIMEDOUT|SIGKILL|SIGSEGV|SIGABRT|fatal error|compiler crashed/,
    "runtime/host/compiler crash cannot satisfy source admission");
  assert.doesNotMatch(error.message,
    /(?:^|\n)\s*(?:define\s+[^\n]*@|; ModuleID\s*=|target triple\s*=)/m,
    "rejected mutable sharing must not leak partial LLVM IR");
  assert.ok(!error.signal, "signal-terminated compiler is not diagnosed rejection");
  return true;
}
