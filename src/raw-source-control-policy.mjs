/**
 * Scalar Wasm source control-character admission before native LLVM invocation.
 * Mirrors the Rust/LLVM/.NET/JS fail-closed raw-source policy, without
 * claiming that this host-side check implements any language syntax.
 *
 * This gate scans ALL raw source, including comments and quoted strings:
 * allowing bidi overrides there permits source text to masquerade as a
 * different signed program during code review.
 */
import {types} from 'node:util';

const MAX_SOURCE_BYTES = 1024 * 1024;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const actualByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const actualBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
// ESC/DEL and Unicode directional marks/overrides/isolate controls. Do NOT
// reject NEL, CR, LF, LS or PS: these are permitted lexical line boundaries.
const forbidden = /[\u001b\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function rejectRawSourceControls(sourceBytes) {
  if (sourceBytes == null || types.isProxy(sourceBytes) ||
      !(sourceBytes instanceof Uint8Array))
    throw new TypeError('WASM source control preflight requires genuine Uint8Array bytes');
  // Read actual typed-array slots, not spoofable subclass properties.
  const length = actualByteLength.call(sourceBytes);
  const backing = actualBuffer.call(sourceBytes);
  if (types.isSharedArrayBuffer(backing))
    throw new TypeError('WASM source control preflight refuses shared backing');
  if (length > MAX_SOURCE_BYTES)
    throw new RangeError('WASM source control preflight exceeds 1 MiB');
  const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(sourceBytes);
  let byteOffset = 0;
  for (const character of text) {
    if (forbidden.test(character))
      throw new Error('WASM_SOURCE_CONTROL_REJECTED U+' +
        character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') +
        ' at byte ' + byteOffset);
    byteOffset += Buffer.byteLength(character, 'utf8');
  }
}
