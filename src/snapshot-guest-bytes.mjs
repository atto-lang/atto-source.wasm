import {types} from "node:util";

// Capture the intrinsic before ordinary code can replace the method at run time.
const copyTrustedBytes = Function.prototype.call.bind(Uint8Array.prototype.set);

// A caller can mutate a SharedArrayBuffer concurrently with a snapshot.
// Hashing bytes from one instant and validating another is not acceptable.
// Cross-realm SABs are recognized by the intrinsic util.types predicate.
export function snapshotGuestBytes(input, maxModuleBytes) {
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input))
    throw new TypeError("expected core WebAssembly bytes");
  const backing = input instanceof ArrayBuffer ? input : input.buffer;
  if (types.isSharedArrayBuffer(backing))
    throw new TypeError("SharedArrayBuffer-backed Wasm input is forbidden");
  const size = input.byteLength;
  if (size > maxModuleBytes)
    throw new Error("Wasm module exceeds maximum byte size");
  // This produces an exclusively owned snapshot, without retaining a view
  // into caller-owned storage. Caller changes after submission cannot affect it.
  // Avoid Uint8Array.from: it consumes an inherited @@iterator, which can
  // invoke attacker-installed prototype code instead of copying raw bytes.
  // Use the captured intrinsic set operation and an owned destination.
  const source = input instanceof ArrayBuffer ?
    new Uint8Array(input) : new Uint8Array(backing, input.byteOffset, size);
  const snapshot = new Uint8Array(size);
  copyTrustedBytes(snapshot, source);
  return snapshot;
}
