import {types} from 'node:util';

// Trusted-host immutable TCP slab. This is NOT a guest Wasm memory import,
// socket connector, network capability, or unsafe shared-memory pointer.
const MAX_BYTES = 1024 * 1024;
// Read genuine typed-array slots instead of overridden source properties or
// iterators; a Uint8Array subclass must not substitute fabricated DATA bytes.
const TypedBytes = Uint8Array;
const typedPrototype = Object.getPrototypeOf(TypedBytes.prototype);
const intrinsicGetter = (prototype, name) => Function.prototype.call.bind(
  Object.getOwnPropertyDescriptor(prototype, name).get);
const viewBuffer = intrinsicGetter(typedPrototype, 'buffer');
const viewSize = intrinsicGetter(typedPrototype, 'byteLength');
const viewOffset = intrinsicGetter(typedPrototype, 'byteOffset');
const dataBuffer = intrinsicGetter(DataView.prototype, 'buffer');
const resizableDescriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable');
const isResizable = resizableDescriptor?.get
  ? Function.prototype.call.bind(resizableDescriptor.get) : () => false;
const setBytes = Function.prototype.call.bind(TypedBytes.prototype.set);
// Intrinsic definition of own indices: inherited setters cannot spoof iterable bytes.
const defineOwnByte = Object.defineProperty;
export class FrozenTcpSlab {
  #bytes;
  #size;
  #pins = new WeakSet();
  #pinCount = 0;
  #retiring = false;
  constructor(source) {
    if (source == null || types.isProxy(source))
      throw new TypeError('invalid TCP byte source');
    let copy = [];
    if (types.isUint8Array(source)) {
      // Backing ownership and credit accounting must use actual typed-array
      // internal slots. Do not call a subclass iterator or byteLength getter.
      const backing = viewBuffer(source);
      if (types.isSharedArrayBuffer(backing))
        throw new TypeError('mutable shared backing memory is forbidden');
      if (!types.isArrayBuffer(backing) || isResizable(backing))
        throw new TypeError('resizable or invalid TCP byte backing is forbidden');
      const size = viewSize(source);
      if (size > MAX_BYTES) throw new RangeError('TCP slab exceeds one MiB');
      const offset = viewOffset(source);
      const privateBytes = new TypedBytes(size);
      setBytes(privateBytes, new TypedBytes(backing, offset, size));
      // Never route a physically snapshotted view through Array.prototype.push:
      // shared-realm prototype poisoning could silently drop or replace bytes.
      // The copy is exclusively reachable through this class's private field.
      this.#size = size;
      this.#bytes = privateBytes;
      return;
    } else {
      if (ArrayBuffer.isView(source)) {
        const backing = types.isDataView(source) ? dataBuffer(source) : viewBuffer(source);
        if (types.isSharedArrayBuffer(backing))
          throw new TypeError('mutable shared backing memory is forbidden');
      }
      if (typeof source[Symbol.iterator] !== 'function')
        throw new TypeError('invalid TCP byte source');
      // Non-Uint8Array iterables are interpreted as explicit byte sequences,
      // not as a view into some presumed physical backing store.
      for (const byte of source) {
        if (copy.length === MAX_BYTES) throw new RangeError('TCP slab exceeds one MiB');
        if (!Number.isInteger(byte) || byte < 0 || byte > 255)
          throw new TypeError('TCP slab requires unsigned byte values');
        defineOwnByte(copy, copy.length,
          {value: byte, writable: true, enumerable: true, configurable: true});
      }
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
