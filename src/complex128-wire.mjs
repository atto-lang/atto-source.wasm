const U64_HEX = /^[0-9a-f]{16}$/;
const EXPONENT_MASK = 0x7ff0_0000_0000_0000n;
const FRACTION_MASK = 0x000f_ffff_ffff_ffffn;
const CANONICAL_QNAN = 0x7ff8_0000_0000_0000n;

function parseBits(value, label) {
  if (typeof value !== "string" || !U64_HEX.test(value)) {
    throw new TypeError(label + " must be exactly 16 lowercase hexadecimal digits");
  }
  return BigInt("0x" + value);
}

function isNaNBits(bits) {
  return (bits & EXPONENT_MASK) === EXPONENT_MASK &&
    (bits & FRACTION_MASK) !== 0n;
}

function canonicalize(bits) {
  return isNaNBits(bits) ? CANONICAL_QNAN : bits;
}

function hex16(bits) {
  return bits.toString(16).padStart(16, "0");
}

/**
 * Encode one complex128 scalar using the proposed portable v1 wire layout.
 *
 * This is a host/memory codec only. It does not imply that Oreslang source
 * complex arithmetic or actor DATA serialization is implemented in the Wasm
 * backend.
 */
export function encodeComplex128Wire(realBits, imaginaryBits) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setBigUint64(0, canonicalize(parseBits(realBits, "realBits")), true);
  view.setBigUint64(8, canonicalize(parseBits(imaginaryBits, "imaginaryBits")), true);
  return bytes;
}

/**
 * Decode one canonical complex128 scalar from a bounded byte view.
 * Non-canonical NaN payload/sign variants fail closed.
 */
export function decodeComplex128Wire(input) {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError("complex128 wire input must be a Uint8Array");
  }
  if (input.byteLength !== 16) {
    throw new RangeError("complex128 wire value must be exactly 16 bytes");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const real = view.getBigUint64(0, true);
  const imaginary = view.getBigUint64(8, true);
  for (const [label, bits] of [["real", real], ["imaginary", imaginary]]) {
    if (isNaNBits(bits) && bits !== CANONICAL_QNAN) {
      throw new RangeError("noncanonical complex128 NaN encoding in " + label);
    }
  }
  return {realBits: hex16(real), imaginaryBits: hex16(imaginary)};
}

export function isCanonicalComplex128Wire(input) {
  try {
    decodeComplex128Wire(input);
    return true;
  } catch {
    return false;
  }
}
