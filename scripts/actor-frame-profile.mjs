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

    // #419's stronger policy: per-cell compiler-generated bounded GEP,
    // actual volatile writes to that cell, and terminal volatile zero.
    // Merely counting unrelated volatile stores is NOT frame evidence.
    const handler = code.match(
      /define\s+i64\s+@oreslang_wasm_actor_on_message\s*\([^)]*\)[^{]*\{([\s\S]*?)^\}/m);
    if (!handler) fail('source-compiled scalar actor handler missing');
    const gepexpr = new RegExp(
      'getelementptr inbounds\\s*\\(?\\[\\s*' + cells +
      ' x i64\\s*\\][^\\n]*?@(?:"atto\\.wasm\\.actor\\.scalar\\.frame\\.v1"|' +
      'atto\\.wasm\\.actor\\.scalar\\.frame\\.v1)[^\\n]*?,\\s*i(?:32|64)\\s+0,\\s*i(?:32|64)\\s+(\\d+)');
    const aliases = new Map();
    const writes = Array.from({length: cells}, () => []);
    const sawSlot = new Set();
    for (const line of handler[1].split('\n')) {
      let slot = null;
      const gep = line.match(gepexpr);
      if (gep) {
        slot = Number(gep[1]);
        if (!Number.isSafeInteger(slot) || slot < 0 || slot >= cells)
          fail('scalar GEP index out of bounds');
        sawSlot.add(slot);
        const declaration = line.match(/^\s*(%[A-Za-z0-9.$_-]+)\s*=\s*getelementptr inbounds/);
        if (declaration) aliases.set(declaration[1], slot);
      }
      if (!/\bstore volatile i64\b/.test(line)) continue;
      if (slot === null) {
        const target = line.match(/,\s*(?:ptr|i64\*)\s+(%[A-Za-z0-9.$_-]+)/);
        if (target && aliases.has(target[1])) slot = aliases.get(target[1]);
      }
      if (slot !== null) writes[slot].push({zero: /\bstore volatile i64 0\s*,/.test(line)});
    }
    if (sawSlot.size !== cells)
      fail('scalar frame lacks explicit bounded GEP for every cell');
    for (const writesForCell of writes)
      if (writesForCell.length < 2 || !writesForCell[writesForCell.length - 1].zero)
        fail('scalar frame initialization/terminal zeroization stores incomplete');
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
