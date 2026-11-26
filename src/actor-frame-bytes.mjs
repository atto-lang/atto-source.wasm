import {types} from "node:util";

// Trusted host-only copies from actor-private, fixed-size linear memory.
const Bytes = Uint8Array;
const apply = Reflect.apply;
const isInteger = Number.isSafeInteger;
const isBytes = types.isUint8Array;
const isShared = types.isSharedArrayBuffer;
const proto = Object.getPrototypeOf(Bytes.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(proto, "buffer").get;
const getLength = Object.getOwnPropertyDescriptor(proto, "byteLength").get;
const memoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer").get;
const backingLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;

// Avoid creating a fresh JS view on every logical frame access. Even grow(0)
// detaches a fixed-memory view, so verify native backing identity before use.
export function refreshPrivateMemoryView(memory, previous = null) {
  const actual = apply(memoryBuffer, memory, []);
  if (isShared(actual)) throw new TypeError("actor memory view rejects shared backing");
  if (previous !== null && isBytes(previous) &&
      apply(getBuffer, previous, []) === actual &&
      apply(getLength, previous, []) === apply(backingLength, actual, [])) return previous;
  return new Bytes(actual);
}

function checkRange(source, offset, length) {
  if (!isBytes(source) || isShared(apply(getBuffer, source, [])) ||
      !isInteger(offset) || !isInteger(length) || offset < 0 || length <= 0 ||
      offset > apply(getLength, source, []) ||
      length > apply(getLength, source, []) - offset) {
    throw new RangeError("actor frame copy range invalid");
  }
}

export function copyPrivateBytesInto(source, offset, length, destination) {
  checkRange(source, offset, length);
  if (!isBytes(destination) || apply(getLength, destination, []) !== length)
    throw new TypeError("actor frame copy requires exact-size Uint8Array");
  const backing = apply(getBuffer, destination, []);
  if (isShared(backing))
    throw new TypeError("actor frame copy rejects shared backing memory");
  if (backing === apply(getBuffer, source, []))
    throw new TypeError("actor frame copy rejects private backing alias");
  for (let i = 0; i < length; i++) destination[i] = source[offset + i];
}

export function copyPrivateBytes(source, offset, length) {
  checkRange(source, offset, length);
  // Never invoke a mutable constructor or TypedArray @@species.
  const copy = new Bytes(length);
  copyPrivateBytesInto(source, offset, length, copy);
  return copy;
}
