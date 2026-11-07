// Compiler-side M2 attestation for the restricted import-free scalar actor.
// This is a provenance/IR contract, not a claim that guest frame slots can
// suspend/migrate or are an independently allocated native engine stack.
const DECLARATION = /^@(?:"atto\.wasm\.actor\.scalar\.frame\.v1"|atto\.wasm\.actor\.scalar\.frame\.v1)\s*=\s*internal global\s*\[(\d+) x i64\] zeroinitializer(?:,|\s|$)/gm;

export function assertCompiledActorScalarFrameV1(ir) {
  if (typeof ir !== 'string' || ir.length === 0 || ir.length > 2 * 1024 * 1024)
    throw TypeError('bounded source LLVM IR required');
  const declarations = [...ir.matchAll(DECLARATION)];
  if (declarations.length !== 1)
    throw Error('missing or ambiguous compiler-generated actor scalar frame v1');
  const cells = Number(declarations[0][1]);
  if (!Number.isSafeInteger(cells) || cells < 2 || cells > 17)
    throw Error('compiler-generated actor scalar frame exceeds fixed field budget');
  if (!ir.includes('getelementptr inbounds [' + cells + ' x i64]'))
    throw Error('actor scalar frame lacks explicit bounded guest-memory slot GEP');
  if ((ir.match(/\bstore volatile i64\b/g) || []).length < 2 * cells)
    throw Error('actor scalar frame initialization/zeroization stores incomplete');
  if (/%message\.slot\s*=\s*alloca\b/.test(ir))
    throw Error('actor message scalar frame fell back to engine-stack alloca');
  return Object.freeze({actorFrameAbi: 'atto-wasm-actor-scalar-frame-v1',
    actorFrameCells: cells, actorFrameBytes: cells * 8});
}
