/**
 * Narrow host-verifier classification, not a compiler or language Error type.
 *
 * A host callback can throw an ordinary JS Error (for example when a guest
 * print_str pointer is invalid). Such an error must never stand in for the
 * compiled guest's checked-overflow trap, even when panic_code was set.
 * The caller controls the complete import adapter and must not deliberately
 * throw WebAssembly.RuntimeError from it.
 */
export function isRuntimeTrapWithPanicCode(error, panicCode) {
  return error instanceof WebAssembly.RuntimeError && panicCode === 1;
}
