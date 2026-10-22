// Backend-neutral compressed32 representation for actor-local managed
// references. This is NOT a raw wasm32 linear-memory address or capability.
const U32_MAX = 0xffff_ffffn;
const ALIGNMENT = 8n;

export const MAX_COMPRESSED32_OFFSET = (U32_MAX - 1n) * ALIGNMENT;
export const MAX_COMPRESSED32_SPAN = U32_MAX * ALIGNMENT;

export function encodeCompressed32(actorOffsetBytes) {
  if (typeof actorOffsetBytes !== "bigint" || actorOffsetBytes < 0n ||
      actorOffsetBytes > MAX_COMPRESSED32_OFFSET ||
      actorOffsetBytes % ALIGNMENT !== 0n) {
    throw new RangeError("actor-relative offset cannot be encoded as compressed32");
  }
  return Number(actorOffsetBytes / ALIGNMENT + 1n);
}

export function decodeCompressed32(word) {
  if (!Number.isSafeInteger(word) || word < 0 || word > 0xffff_ffff) {
    throw new RangeError("compressed32 word must be unsigned u32");
  }
  const unsigned = BigInt(word);
  return unsigned === 0n ? null : (unsigned - 1n) * ALIGNMENT;
}

export function decodeStoredCompressed32(storedWord) {
  if (typeof storedWord !== "bigint" || storedWord < 0n || storedWord > U32_MAX) {
    throw new RangeError("compressed32 high bits must be zero");
  }
  return decodeCompressed32(Number(storedWord));
}

export function dereferenceCompressed32(storedWord, logicalSpanBytes, accessBytes) {
  const offset = decodeStoredCompressed32(storedWord);
  if (offset === null) throw new Error("null compressed32 reference");
  if (typeof logicalSpanBytes !== "bigint" || typeof accessBytes !== "bigint" ||
      logicalSpanBytes < 0n || accessBytes <= 0n ||
      offset > logicalSpanBytes || accessBytes > logicalSpanBytes - offset) {
    throw new RangeError("compressed32 access outside logical actor span");
  }
  return offset;
}
