import {ActorArena} from './actor-arena.mjs';
import {makeActorFrameReceipt} from './actor-frame-quiescence.mjs';

// One 16-byte trusted HOST logical frame per synchronous invocation.
// The compiler-generated guest frame ABI is separately versioned and checked.
// No Promise, nested reentrant guest call, guest borrow or suspended frame is admitted.
const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;

function requireI64(value) {
  if (typeof value !== 'bigint' || value < MIN_I64 || value > MAX_I64)
    throw TypeError('actor managed frame requires signed i64');
}

function encodeFrame(input, output = null) {
  const bytes = new Uint8Array(16);
  for (const [offset, value] of [[0, input], [8, output]]) {
    if (value === null) continue;
    let bits = BigInt.asUintN(64, value);
    for (let i = 0; i < 8; i++) {
      bytes[offset + i] = Number(bits & 255n);
      bits >>= 8n;
    }
  }
  return bytes;
}

export function withManagedActorTurn(arena, invoke, {input = 0n, resultType = 'void'} = {}) {
  if (!(arena instanceof ActorArena) || typeof invoke !== 'function')
    throw TypeError('actor-owned arena and callable required');
  requireI64(input);
  if (resultType !== 'void' && resultType !== 'i64')
    throw TypeError('unsupported actor result frame type');

  // beginTurn is authoritative: it rejects reentrancy and retired arenas.
  const turn = arena.beginTurn();
  let value;
  try {
    const frame = arena.allocScratch(turn, 16);
    arena.write(turn, frame, encodeFrame(input));
    value = invoke();
    if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
        typeof value.then === 'function')
      throw Error('suspending guest frame is unsupported');
    if (resultType === 'i64') requireI64(value);
    else if (value !== undefined) throw Error('void actor guest returned a value');
    arena.write(turn, frame, encodeFrame(input, resultType === 'i64' ? value : null));
  } finally {
    // Always zero scratch and revoke turn authority. Errors remain carrier-fatal.
    arena.endTurn(turn);
  }
  if (arena.pendingLifetimePins !== 0)
    throw Error('actor guest turn left outstanding lifetime leases');
  // Mint receipt ONLY after the authoritative endTurn completed.
  return {value, frame: makeActorFrameReceipt(false)};
}
