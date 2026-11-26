/**
 * Internal control-plane 32-bit storage word. Host-only prototype, not an
 * ActorRef, object address, capability, serializable token or GC guarantee.
 * Binary layout: high 12 bits generation; low 20 bits slot + 1; zero is null.
 * Issuer/domain/epoch/type/lifetime must be authenticated by the caller's
 * trusted runtime metadata before it may dereference any object.
 */
export const CONTROL_REF32_STORAGE_ABI_V1 = 'control_generation12_slot20_v1';
export const CONTROL_REF32_SLOT_BITS = 20;
export const CONTROL_REF32_GENERATION_BITS = 12;
export const CONTROL_REF32_SLOT_LIMIT = 2 ** CONTROL_REF32_SLOT_BITS - 1;
export const CONTROL_REF32_GENERATION_LIMIT = 2 ** CONTROL_REF32_GENERATION_BITS - 1;
const WORD_MAX = 0xffff_ffff;
const SLOT_SCALE = 2 ** CONTROL_REF32_SLOT_BITS;

export function require_control_ref32_abi_v1(requested) {
  if (requested !== CONTROL_REF32_STORAGE_ABI_V1) {
    throw new RangeError('E_CONTROL_REF32_ABI: storage profile mismatch');
  }
}

/** Return an unsigned u32 Number, never a JS signed-bitwise result. */
export function encode_control_ref32_v1(slot_index, generation) {
  if (!Number.isSafeInteger(slot_index) || slot_index < 0 ||
      slot_index >= CONTROL_REF32_SLOT_LIMIT ||
      !Number.isSafeInteger(generation) || generation <= 0 ||
      generation > CONTROL_REF32_GENERATION_LIMIT) {
    throw new RangeError('E_CONTROL_REF32_BITS: invalid slot/generation');
  }
  return generation * SLOT_SCALE + slot_index + 1;
}

/** Decode the bit fields only; does not authenticate owner or live slot. */
export function decode_control_ref32_v1(word) {
  if (!Number.isSafeInteger(word) || word < 0 || word > WORD_MAX) {
    throw new RangeError('E_CONTROL_REF32_BITS: unsigned u32 required');
  }
  if (word === 0) return null;
  const low = word % SLOT_SCALE;
  const generation = Math.floor(word / SLOT_SCALE);
  if (low === 0 || generation === 0) {
    throw new RangeError('E_CONTROL_REF32_BITS: forbidden slot/generation zero');
  }
  return {slot_index: low - 1, generation};
}
