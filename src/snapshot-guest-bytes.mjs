// Portable ES intrinsics are sufficient to brand-check cross-realm ArrayBuffers
// and typed-array/DataView slots. Do not import node:util: this byte admission
// primitive is also needed in browser module Workers and desktop WebViews.
// Capture trusted builtins before application code can replace them.
const call = Function.prototype.call;
const bind = Function.prototype.bind;
const nativeCall = bind.call(call, call);
const boundGetter = getter => bind.call(call, getter);
const arrayBufferSize = boundGetter(
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedSlot = name => boundGetter(
  Object.getOwnPropertyDescriptor(typedArrayPrototype, name).get);
const viewSlot = name => boundGetter(
  Object.getOwnPropertyDescriptor(DataView.prototype, name).get);
const typedBuffer = typedSlot("buffer");
const typedSize = typedSlot("byteLength");
const typedOffset = typedSlot("byteOffset");
const dataBuffer = viewSlot("buffer");
const dataSize = viewSlot("byteLength");
const dataOffset = viewSlot("byteOffset");
const copyTrustedBytes = boundGetter(Uint8Array.prototype.set);
const isNativeView = ArrayBuffer.isView;
const OwnedBytes = Uint8Array;

// Intrinsic internal-slot checks work across realms and reject proxies and
// Symbol.toStringTag impersonators without accessing attacker properties.
const isArrayBuffer = value => {
  try { arrayBufferSize(value); return true; }
  catch { return false; }
};
const isDataView = value => {
  try { dataSize(value); return true; }
  catch { return false; }
};

// Never accept a SharedArrayBuffer-backed view (even from a foreign realm).
// A valid typed-array/DataView object's backing must pass the *ordinary*
// ArrayBuffer brand check. This stays fail-closed even where the global
// SharedArrayBuffer constructor is unavailable.
export function snapshotGuestBytes(input, maxModuleBytes) {
  if (!Number.isSafeInteger(maxModuleBytes) || maxModuleBytes < 0 ||
      maxModuleBytes > 16 * 1024 * 1024)
    throw new TypeError("invalid maximum module size");

  const isBuffer = isArrayBuffer(input);
  if (!isBuffer && !isNativeView(input))
    throw new TypeError("expected core WebAssembly bytes");

  const dataView = !isBuffer && isDataView(input);
  const backing = isBuffer ? input : dataView ? dataBuffer(input) : typedBuffer(input);
  if (!isArrayBuffer(backing))
    throw new TypeError("SharedArrayBuffer-backed Wasm input is forbidden");

  const size = isBuffer ? arrayBufferSize(input) :
    dataView ? dataSize(input) : typedSize(input);
  const offset = isBuffer ? 0 :
    dataView ? dataOffset(input) : typedOffset(input);
  if (size > maxModuleBytes)
    throw new Error("Wasm module exceeds maximum byte size");

  // Copy through captured native slots; never call an inherited @@iterator,
  // custom buffer getter or attacker-controlled element property.
  const source = new OwnedBytes(backing, offset, size);
  const snapshot = new OwnedBytes(size);
  copyTrustedBytes(snapshot, source);
  return snapshot;
}
