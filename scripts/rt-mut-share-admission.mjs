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
  // The bridge deliberately truncates the human-readable error message to
  // 4 KiB, but retains complete bounded stderr. Inspect both to prevent
  // forged successes with IR or crash evidence past the message truncation.
  const crash = /spawn |ENOENT|EACCES|ETIMEDOUT|SIGKILL|SIGSEGV|SIGABRT|fatal error|compiler crashed|segmentation fault|aborted|core dumped|panicked at|stack overflow|command not found|LLVM ERROR/i;
  const partialIR = /(?:^|\n)\s*(?:define\s+[^\n]*@|; ModuleID\s*=|target triple\s*=|source_filename\s*=|declare\s+[^\n]*@|attributes\s+#\d+\s*=)/m;
  assert.doesNotMatch(error.message, crash, "host/compiler crash cannot count as source denial");
  assert.doesNotMatch(error.message, partialIR, "failed compiler cannot leak LLVM IR");
  assert.doesNotMatch(error.stderr ?? "", crash, "compiler stderr contains crash evidence");
  assert.doesNotMatch(error.stderr ?? "", partialIR, "compiler stderr leaked LLVM IR");
  // A plain Error(message) is not compiler evidence. The bridge must carry
  // the real exit status, signal and independent stderr/stdout streams.
  assert.equal(error.stdout, "",
    "rejected source must not emit partial IR or any stdout");
  assert.equal(error.status, 1,
    "guarded-sharing denial requires the real compiler's controlled exit(1)");
  assert.equal(error.signal, null,
    "signal-terminated compiler is not diagnosed rejection");
  assert.match(error.stderr ?? "",
    /oreslang-llvmc: native rt mut share requires verified SharedMutex<T> capability, guarded lowering and allocation-domain proof/,
    "diagnostic must originate from compiler stderr, not a synthetic message");
  // The mandatory capability denial must be the entire compiler diagnostic.
  // A plausible first line followed by a parser/usage error is not proof
  // that the exact source was rejected for the guarded-sharing reason.
  assert.match(error.stderr ?? "",
    /^oreslang-llvmc: native rt mut share requires verified SharedMutex<T> capability, guarded lowering and allocation-domain proof; refusing unsynchronized alias at byte [0-9]+(?: \[file: [A-Za-z0-9_.-]+\])?\r?\n?$/,
    "mixed or multiline compiler errors cannot establish guarded-sharing denial");
  assert.ok(error.code == null && error.errno == null && error.syscall == null && error.cause == null,
    "host/transport failure metadata cannot stand in for compiler rejection");

  return true;
}
