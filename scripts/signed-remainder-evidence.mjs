// Fail-closed evidence classification for the mandatory real LLVM->WASM
// signed-remainder test. These predicates NEVER prove a compiler or guest ran;
// they only reject false-positive error families in a separately pinned run.
export function isNativeSemanticRejection(error, requiredDiagnostic) {
  if (!(requiredDiagnostic instanceof RegExp) ||
      requiredDiagnostic.global || requiredDiagnostic.sticky ||
      typeof error?.message !== "string") return false;
  const message = error.message;
  // Proof of an ordinary compiler-owned diagnostic must include the bounded
  // spawnSync result, not merely a string resembling stderr. A killed
  // compiler, ENOENT, nonzero-with-IR or arbitrary linker error is not a
  // valid expected source rejection.
  const evidence = error.commandEvidence;
  if (!evidence || typeof evidence !== "object" || evidence.status !== 1 ||
      evidence.signal !== null || evidence.spawnError !== null ||
      evidence.stdoutLength !== 0 || typeof evidence.command !== "string" ||
      !evidence.command.endsWith("/compiler-exact")) return false;
  // The bridge must have invoked an actual bounded compiler and observed its
  // own diagnosed failure; missing executables, Clang, and bad env are not it.
  if (!/^command failed \([^()\r\n]*\/compiler-exact\): oreslang-llvmc:\s+/i.test(message)) return false;
  if (/unknown option|not found|permission denied|failed to execute|not executable/i.test(message))
    return false;
  const diagnostic = message.match(/oreslang-llvmc:\s*([^\r\n]+)/i)?.[1] || "";
  return requiredDiagnostic.test(diagnostic);
}

export function isExecutedWasmOverflowTrap(error) {
  // runIsolatedCoreGuest returns only after worker termination. It prefixes
  // actual guest failures with this marker; deadline, worker death, bad ABI,
  // and missing source are never accepted as arithmetic traps.
  return typeof error?.message === "string" &&
    /^guest rejected or failed: (?:unreachable|integer overflow)$/i.test(error.message);
}
