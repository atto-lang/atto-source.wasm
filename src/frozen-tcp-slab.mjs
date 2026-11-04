import {types} from "node:util";
// Read the backing-store slot with captured intrinsics. A typed-array
// subclass can shadow .buffer with a forged getter; that must not hide SAB.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsicTypedBuffer = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get);
const intrinsicDataViewBuffer = Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(DataView.prototype, "buffer").get);
// Trusted-host immutable TCP slab. This is NOT a guest Wasm memory import,
// socket connector, network capability, or unsafe shared-memory pointer.
const MAX_BYTES = 1024 * 1024;
export class FrozenTcpSlab {
  #bytes;
  #size;
  #pins = new WeakSet();
  #pinCount = 0;
  #retiring = false;
  constructor(source) {
    if (source == null || typeof source[Symbol.iterator] !== 'function')
      throw new TypeError('invalid TCP byte source');
    if (ArrayBuffer.isView(source)) {
      const backing = types.isDataView(source)
        ? intrinsicDataViewBuffer(source) : intrinsicTypedBuffer(source);
      if (types.isSharedArrayBuffer(backing))
        throw new TypeError('mutable shared backing memory is forbidden');
    }
    const copy = [];
    for (const byte of source) {
      if (copy.length === MAX_BYTES) throw new RangeError('TCP slab exceeds one MiB');
      if (!Number.isInteger(byte) || byte < 0 || byte > 255)
        throw new TypeError('TCP slab requires unsigned byte values');
      copy.push(byte);
    }
    this.#size = copy.length;
    this.#bytes = Object.freeze(copy);
  }
  get size() { return this.#size; }
  get freed() { return this.#bytes === null; }
  get pinCount() { return this.#pinCount; }
  pin() {
    if (this.#retiring) throw new Error('slab retired');
    if (this.#pinCount >= Number.MAX_SAFE_INTEGER) throw new Error('pin count exhausted');
    const pin = Object.freeze({});
    this.#pins.add(pin);
    this.#pinCount++;
    return pin;
  }
  readByte(pin, index) {
    if (!this.#pins.has(pin)) throw new Error('invalid TCP slab pin');
    if (this.#bytes === null) throw new Error('TCP slab storage retired');
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.#bytes.length)
      throw new RangeError('TCP slab byte index');
    return this.#bytes[index];
  }
  releasePin(pin) {
    if (!this.#pins.has(pin)) return false;
    this.#pins.delete(pin);
    this.#pinCount--;
    this.#finalize();
    return true;
  }
  retire() { this.#retiring = true; this.#finalize(); }
  #finalize() {
    // Drop the private backing region after the final physical I/O/reader pin.
    // This releases ownership for JS GC; it is NOT secure memory zeroization.
    // The trusted transport owner must call retire only after kernel IO quiesces.
    if (this.#retiring && this.#pinCount === 0) this.#bytes = null;
  }
}
