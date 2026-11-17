import {types} from "node:util";

const TypedBytes = Uint8Array;
const typedArrayPrototype = Object.getPrototypeOf(TypedBytes.prototype);
const slotGetter = name => Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, name).get);
const viewBuffer = slotGetter("buffer");
const viewSize = slotGetter("byteLength");
const viewOffset = slotGetter("byteOffset");
const copyBytes = Function.prototype.call.bind(TypedBytes.prototype.set);
const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
const isResizable = resizableGetter
  ? Function.prototype.call.bind(resizableGetter)
  : () => false;

/**
 * Bounded, raw-source admission for both scalar and actor Wasm bridges.
 * Uses native internal slots, rejects proxies/shared or resizable backing,
 * and snapshots before decoding/scanning so caller mutation cannot change
 * the bytes after admission.
 */
export function rejectRawTerminalSourceControls(sourceBytes) {
  if (types.isProxy(sourceBytes) || !types.isUint8Array(sourceBytes))
    throw new TypeError("WASM source preflight requires genuine Uint8Array bytes");
  const backing = viewBuffer(sourceBytes);
  if (types.isSharedArrayBuffer(backing))
    throw new TypeError("WASM source preflight forbids shared backing memory");
  if (!types.isArrayBuffer(backing) || isResizable(backing))
    throw new TypeError("WASM source preflight requires fixed ArrayBuffer backing");

  const size = viewSize(sourceBytes);
  if (size > 1024 * 1024)
    throw new RangeError("WASM source preflight byte budget exceeded");
  const offset = viewOffset(sourceBytes);
  const snapshot = new TypedBytes(size);
  copyBytes(snapshot, new TypedBytes(backing, offset, size));

  const text = new TextDecoder("utf-8", {fatal: true}).decode(snapshot);
  // ESC/DEL/NUL are ASCII single bytes; scan the copied bytes to preserve
  // precise UTF-8 offsets even when preceding text contains astral scalars.
  for (let at = 0; at < snapshot.byteLength; at++) {
    const byte = snapshot[at];
    if (byte === 0)
      throw Error("WASM source preflight contains NUL byte at byte offset " + at);
    if (byte === 0x1b || byte === 0x7f)
      throw Error("WASM source preflight contains terminal control at byte offset " + at);
  }
  return text;
}
