// Explicit, opt-in *compiler* frame layouts. Distinct from trusted host
// actor-arena-v1 quiescence receipts. Text IR checks are defense-in-depth;
// only pinned native compiler + real guest execution can establish semantics.
export const ACTOR_FRAME_PROFILES = Object.freeze({
  SCALAR: 'atto-wasm-actor-scalar-frame-v1',
  STACK64: 'atto-wasm-actor-stack64-v1'
});

function fail(reason) { throw Error('actor frame profile: ' + reason); }

export function assertActorFrameProfile(ir, profile) {
  if (profile !== ACTOR_FRAME_PROFILES.SCALAR &&
      profile !== ACTOR_FRAME_PROFILES.STACK64)
    fail('unknown or implicit compiler frame profile');
  if (typeof ir !== 'string' || ir.length === 0 || ir.length > 2 * 1024 * 1024)
    fail('bounded LLVM IR text required');
  // Strip full-line LLVM comments. A comment can never satisfy ABI evidence.
  const code = ir.replace(/^[ \t]*;[^\n]*$/gm, '');
  const scalar = [...code.matchAll(
    /^[ \t]*@(?:"atto\.wasm\.actor\.scalar\.frame\.v1"|atto\.wasm\.actor\.scalar\.frame\.v1)\s*=\s*internal global\s*\[(\d+) x i64\]\s+zeroinitializer\b/gm)];
  const stack = [...code.matchAll(
    /^[ \t]*@oreslang\.wasm\.actor\.frame\.slots\s*=\s*internal global\s*\[(\d+) x i64\](?:[ \t]|$)/gm)];
  if (scalar.length + stack.length !== 1)
    fail('missing, competing or duplicate compiler frame layouts');
  if (/%message\.slot\s*=\s*alloca\b/.test(code))
    fail('unlowered actor message stack alloca');
  if (profile === ACTOR_FRAME_PROFILES.SCALAR) {
    if (scalar.length !== 1) fail('scalar profile requires scalar frame, not 64-slot stack');
    const cells = Number(scalar[0][1]);
    if (!Number.isSafeInteger(cells) || cells < 2 || cells > 17)
      fail('scalar cell budget must be 2..17');
    if (!new RegExp('getelementptr inbounds\\s*\\[\\s*' + cells + ' x i64\\s*\\]').test(code) ||
        (code.match(/\bstore volatile i64\b/g) || []).length < cells * 2 ||
        (code.match(/\bstore volatile i64 0\s*,/g) || []).length < cells)
      fail('scalar frame bounded access/initialization/zeroization not demonstrated');
    return Object.freeze({actorFrameProfile: profile, actorFrameCells: cells});
  }
  if (stack.length !== 1 || Number(stack[0][1]) !== 64)
    fail('stack64 requires exactly 64 owned i64 slots');
  if (!/^[ \t]*@oreslang\.wasm\.actor\.frame\.depth\s*=/m.test(code) ||
      !/getelementptr inbounds\s*\[\s*64 x i64\s*\]/.test(code) ||
      !/@atto\.actor\.guest\.frame\.denied\b/.test(code) ||
      !/@atto\.actor\.guest\.frames\.clean\b/.test(code) ||
      !/store volatile i64\b/.test(code))
    fail('stack64 depth/bounds/cleanup evidence missing');
  return Object.freeze({actorFrameProfile: profile, actorFrameCells: 64});
}
