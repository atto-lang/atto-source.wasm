/**
 * Scalar Wasm source control-character admission before native LLVM invocation.
 * Mirrors the Rust/LLVM/.NET/JS fail-closed raw-source policy, without
 * claiming that this host-side check implements any language syntax.
 *
 * This gate scans ALL raw source, including comments and quoted strings:
 * allowing bidi overrides there permits source text to masquerade as a
 * different signed program during code review.
 */
import {types, TextDecoder as NodeTextDecoder} from 'node:util';

const MAX_SOURCE_BYTES = 1024 * 1024;
// Capture trusted intrinsics at module load. A host plugin must not be able to
// disable source admission by mutating global TextDecoder, util.types or
// String.prototype after the bridge has imported this policy.
const trustedIsProxy = types.isProxy;
const trustedIsUint8Array = types.isUint8Array;
const trustedIsSharedArrayBuffer = types.isSharedArrayBuffer;
const trustedDecode = NodeTextDecoder.prototype.decode;
const trustedCodePointAt = String.prototype.codePointAt;
const trustedApply = Reflect.apply;
const decoder = new NodeTextDecoder('utf-8', {fatal: true, ignoreBOM: true});
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const actualByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const actualBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
// ESC/DEL and Unicode directional marks/overrides/isolate controls. Do NOT
// reject NEL, CR, LF, LS or PS: these are permitted lexical line boundaries.
// Explicit scalar ranges avoid a mutable RegExp.prototype.test dependency.
function forbiddenCodePoint(cp) {
  return cp === 0x1b || cp === 0x7f || cp === 0x61c ||
    cp === 0x200e || cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069);
}

export function rejectRawSourceControls(sourceBytes) {
  if (sourceBytes == null || trustedIsProxy(sourceBytes) ||
      !trustedIsUint8Array(sourceBytes))
    throw new TypeError('WASM source control preflight requires genuine Uint8Array bytes');
  // Read actual typed-array slots, not spoofable subclass properties.
  const length = actualByteLength.call(sourceBytes);
  const backing = actualBuffer.call(sourceBytes);
  if (trustedIsSharedArrayBuffer(backing))
    throw new TypeError('WASM source control preflight refuses shared backing');
  if (length > MAX_SOURCE_BYTES)
    throw new RangeError('WASM source control preflight exceeds 1 MiB');
  const text = trustedApply(trustedDecode, decoder, [sourceBytes]);
  let byteOffset = 0;
  for (let i = 0; i < text.length;) {
    const cp = trustedApply(trustedCodePointAt, text, [i]);
    if (forbiddenCodePoint(cp))
      throw new Error('WASM_SOURCE_CONTROL_REJECTED U+' +
        cp.toString(16).toUpperCase().padStart(4, '0') +
        ' at byte ' + byteOffset);
    // Fatal UTF-8 decoder guarantees well-formed Unicode scalar values.
    // Compute offsets without mutable Buffer.byteLength or string iterators.
    i += cp > 0xffff ? 2 : 1;
    byteOffset += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
}
