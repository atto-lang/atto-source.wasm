import {types} from "node:util";

// Capture the intrinsic before ordinary code can replace the method at run time.
const arrayBufferSize = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedSlot = name => Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, name).get);
const viewSlot = name => Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(DataView.prototype, name).get);
const typedBuffer = typedSlot('buffer'), typedSize = typedSlot('byteLength'),
  typedOffset = typedSlot('byteOffset');
const dataBuffer = viewSlot('buffer'), dataSize = viewSlot('byteLength'),
  dataOffset = viewSlot('byteOffset');
const copyTrustedBytes = Function.prototype.call.bind(Uint8Array.prototype.set);

// A caller can mutate a SharedArrayBuffer concurrently with a snapshot.
// Hashing bytes from one instant and validating another is not acceptable.
// Cross-realm SABs are recognized by the intrinsic util.types predicate.
export function snapshotGuestBytes(input, maxModuleBytes) {
  // This helper is exported: never rely on a higher-level caller to enforce
  // the allocation ceiling before an independently invoked snapshot.
  if (!Number.isSafeInteger(maxModuleBytes) || maxModuleBytes < 0 ||
      maxModuleBytes > 16 * 1024 * 1024)
    throw new TypeError("invalid maximum module size");
  const isBuffer = types.isArrayBuffer(input);
  if (!isBuffer && !ArrayBuffer.isView(input))
    throw new TypeError("expected core WebAssembly bytes");
  const isDataView = types.isDataView(input);
  const backing = isBuffer ? input : isDataView ? dataBuffer(input) : typedBuffer(input);
  if (types.isSharedArrayBuffer(backing))
    throw new TypeError("SharedArrayBuffer-backed Wasm input is forbidden");
  const size = isBuffer ? arrayBufferSize(input) : isDataView ? dataSize(input) : typedSize(input);
  const offset = isBuffer ? 0 : isDataView ? dataOffset(input) : typedOffset(input);
  if (size > maxModuleBytes)
    throw new Error("Wasm module exceeds maximum byte size");
  // This produces an exclusively owned snapshot, without retaining a view
  // into caller-owned storage. Caller changes after submission cannot affect it.
  // Avoid Uint8Array.from: it consumes an inherited @@iterator, which can
  // invoke attacker-installed prototype code instead of copying raw bytes.
  // Use the captured intrinsic set operation and an owned destination.
  const source = new Uint8Array(backing, offset, size);
  const snapshot = new Uint8Array(size);
  copyTrustedBytes(snapshot, source);
  return snapshot;
}
