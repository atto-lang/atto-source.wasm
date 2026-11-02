import assert from "node:assert/strict";

// A rejected guest must reach the reviewed compiler image and fail because of
// the guarded-sharing contract. Host errors and generic parser failures do not
// establish fail-closed source admission.
export function assertNativeMutShareDenial(error) {
  assert.ok(error && typeof error.message === "string",
    "rejection requires a structured compiler error");
  assert.match(error.message,
    /^command failed \([^)]+[\\/]compiler-exact\): oreslang-llvmc: native rt mut share requires verified SharedMutex<T> capability, guarded lowering and allocation-domain proof/,
    "expected the exact staged native compiler and guarded-sharing diagnostic");
  assert.doesNotMatch(error.message,
    /spawn |ENOENT|EACCES|ETIMEDOUT|SIGKILL|SIGSEGV|SIGABRT|fatal error|compiler crashed|segmentation fault|aborted|core dumped|panicked at|stack overflow|command not found|LLVM ERROR/i,
    "runtime/host/compiler crash cannot satisfy source admission");
  assert.doesNotMatch(error.message,
    /(?:^|\n)\s*(?:define\s+[^\n]*@|; ModuleID\s*=|target triple\s*=|source_filename\s*=|declare\s+[^\n]*@|attributes\s+#\d+\s*=)/m,
    "rejected mutable sharing must not leak partial LLVM IR");
  assert.equal(error.stdout ?? "", "",
    "rejected source must not emit partial IR or any stdout");
  assert.ok(!error.signal, "signal-terminated compiler is not diagnosed rejection");
  assert.ok(error.code == null && error.errno == null && error.syscall == null && error.cause == null,
    "host/transport failure metadata cannot stand in for compiler rejection");
  assert.ok(error.status == null || (Number.isInteger(error.status) && error.status > 0),
    "successful or malformed process status cannot prove compiler rejection");
  return true;
}
