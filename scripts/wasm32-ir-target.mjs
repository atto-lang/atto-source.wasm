/**
 * Fail-closed declaration check for the experimental Oreslang LLVM IR bridge.
 * LLVM emits one explicit target triple for wasm32; never infer it from an
 * IR comment, a module-identifier string, or the linker target flag.
 */
export function assertWasm32IrTarget(ir) {
  if (typeof ir !== 'string' || Buffer.byteLength(ir, 'utf8') > 2 * 1024 * 1024)
    throw Error('generated IR exceeds 2 MiB or is not text');
  const declarations = ir.split(/\r?\n/).filter(line =>
    /^[ \t]*target[ \t]+triple[ \t]*=/.test(line));
  if (declarations.length !== 1 ||
      !/^[ \t]*target[ \t]+triple[ \t]*=[ \t]*"wasm32-unknown-unknown"[ \t]*$/.test(declarations[0]))
    throw Error('compiler did not emit wasm32 target-marked IR');
  return true;
}
