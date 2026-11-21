// Compiler-side M2 admission for the restricted import-free scalar actor.
// An IR text verifier is defense in depth, not a replacement for trusted
// compiler identity, actual guest execution or independent code review.
const FRAME = 'atto\\.wasm\\.actor\\.scalar\\.frame\\.v1';
const DECLARATION = new RegExp(
  '^@(?:"' + FRAME + '"|' + FRAME + ')\\s*=\\s*internal global\\s*\\[(\\d+) x i64\\] zeroinitializer(?:,|\\s|$)',
  'gm');
const HANDLER = /define\s+i64\s+@oreslang_wasm_actor_on_message\s*\([^)]*\)[^{]*\{([\s\S]*?)^\}/m;
const ALIAS = /^\s*(%[A-Za-z0-9.$_-]+)\s*=\s*getelementptr inbounds/;
const STORE = /\bstore volatile i64\b/;
const ZERO_STORE = /\bstore volatile i64 0\s*,/;
const STORE_TARGET = /,\s*(?:ptr|i64\*)\s+(%[A-Za-z0-9.$_-]+)/;

export function assertCompiledActorScalarFrameV1(ir) {
  if (typeof ir !== 'string' || ir.length === 0 || ir.length > 2 * 1024 * 1024)
    throw TypeError('bounded source LLVM IR required');
  const declarations = [...ir.matchAll(DECLARATION)];
  if (declarations.length !== 1)
    throw Error('missing or ambiguous compiler-generated actor scalar frame v1');
  const cells = Number(declarations[0][1]);
  if (!Number.isSafeInteger(cells) || cells < 2 || cells > 17)
    throw Error('compiler-generated actor scalar frame exceeds fixed field budget');
  const match = ir.match(HANDLER);
  if (!match) throw Error('source-compiled scalar actor message handler missing');
  const body = match[1];
  // LLVM IRBuilder may emit a named GEP instruction OR constant-expression
  // GEP embedded in the store. Both spellings are valid in LLVM 14-20.
  const gep = new RegExp(
    'getelementptr inbounds\\s*\\(?\\[' + cells +
    ' x i64\\][^\\n]*?@(?:"' + FRAME + '"|' + FRAME +
    ')[^\\n]*?,\\s*i(?:32|64)\\s+0,\\s*i(?:32|64)\\s+(\\d+)');
  const aliases = new Map();
  const writes = Array.from({length: cells}, () => []);
  const sawSlot = new Set();
  for (const line of body.split('\n')) {
    const geps = line.match(gep);
    let slot = null;
    if (geps) {
      slot = Number(geps[1]);
      if (!Number.isSafeInteger(slot) || slot < 0 || slot >= cells)
        throw Error('actor scalar frame GEP index out of bounds');
      sawSlot.add(slot);
      const alias = line.match(ALIAS);
      if (alias) aliases.set(alias[1], slot);
    }
    if (!STORE.test(line)) continue;
    if (slot === null) {
      const target = line.match(STORE_TARGET);
      if (target && aliases.has(target[1])) slot = aliases.get(target[1]);
    }
    if (slot !== null) writes[slot].push({zero: ZERO_STORE.test(line)});
  }
  if (sawSlot.size !== cells)
    throw Error('actor scalar frame lacks explicit bounded guest-memory slot GEP');
  for (let index = 0; index < cells; index++) {
    const slot = writes[index];
    if (slot.length < 2 || !slot[slot.length - 1].zero)
      throw Error('actor scalar frame initialization/zeroization stores incomplete');
  }
  if (/%message\.slot\s*=\s*alloca\b/.test(ir))
    throw Error('actor message scalar frame fell back to engine-stack alloca');
  return Object.freeze({actorFrameAbi: 'atto-wasm-actor-scalar-frame-v1',
    actorFrameCells: cells, actorFrameBytes: cells * 8});
}
