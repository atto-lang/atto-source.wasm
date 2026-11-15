/**
 * Decode canonical compiler-generated atto.exports.v1 Wasm custom sections.
 *
 * This is declarative symbol metadata, NOT a grant of an import capability.
 * The runtime does not yet offer package-aware module graph resolution; a
 * consumer must not treat package-only entries as publicly linkable.
 */
// Do not strip a leading UTF-8 BOM: it is not part of a canonical identifier.
// `ignoreBOM: true` preserves U+FEFF so the identifier check rejects it.
// Capture trusted Wasm intrinsics at module initialization. Realm-local code
// changing the global methods later must not erase or forge export metadata.
const NativeWasmModule = WebAssembly.Module;
// Snapshot the native constructor: a same-realm global replacement could
// otherwise rewrite the Wasm custom-section byte view and widen visibility.
const NativeUint8Array = Uint8Array;
const nativeCreate = Object.create;
const nativeFreeze = Object.freeze;
const nativeCustomSections = NativeWasmModule.customSections;
const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
// Preserve native UTF-8 validation even if code in the same realm later
// replaces TextDecoder prototype methods.
const nativeDecodeUtf8 = Function.prototype.call.bind(TextDecoder.prototype.decode);
// Native subarray still consults mutable Symbol.species; use direct native
// byte views of the original custom-section ArrayBuffer instead.
// Untrusted numeric tags must never resolve via Object.prototype. A polluted
// prototype could otherwise turn an invalid kind/visibility into a public grant.
const kinds = nativeFreeze(Object.assign(nativeCreate(null), {1: 'class', 2: 'fnc', 3: 'actor', 4: 'enum'}));
const visibilities = nativeFreeze(Object.assign(nativeCreate(null), {1: 'public', 2: 'package'}));
// Max 1024 canonical entries: uleb length (2), name (256), kind and visibility (2).
// Count itself occupies at most two bytes. Reject oversized sections early.
const MAX_MANIFEST_BYTES = 2 + 1024 * (2 + 256 + 2);

export function readDeclarativeExports(module) {
  if (!(module instanceof NativeWasmModule))
    throw new TypeError('EXPORT_MANIFEST_MODULE: expected validated WebAssembly.Module');
  const sections = nativeCustomSections(module, 'atto.exports.v1');
  if (sections.length > 1) throw new TypeError('EXPORT_MANIFEST_DUPLICATE_SECTION');
  if (!sections.length) return nativeFreeze([]);
  const sectionBuffer = sections[0];
  const bytes = new NativeUint8Array(sectionBuffer);
  if (bytes.byteLength > MAX_MANIFEST_BYTES)
    throw new TypeError('EXPORT_MANIFEST_SECTION_TOO_LARGE');
  let pos = 0;
  function byte() {
    if (pos >= bytes.length) throw new TypeError('EXPORT_MANIFEST_TRUNCATED');
    return bytes[pos++];
  }
  function uleb() {
    let result = 0;
    for (let i = 0; i < 5; i++) {
      const b = byte();
      if (i === 4 && b > 0x0f) throw new TypeError('EXPORT_MANIFEST_VARINT_OVERFLOW');
      result += (b & 0x7f) * (2 ** (i * 7));
      if (!(b & 0x80)) {
        if (i > 0 && (b & 0x7f) === 0)
          throw new TypeError('EXPORT_MANIFEST_VARINT_NONCANONICAL');
        return result;
      }
    }
    throw new TypeError('EXPORT_MANIFEST_VARINT_OVERFLOW');
  }
  function name() {
    const len = uleb();
    if (len < 1 || len > 256 || len > bytes.length - pos)
      throw new TypeError('EXPORT_MANIFEST_NAME_LENGTH');
    const value = nativeDecodeUtf8(decoder, new NativeUint8Array(sectionBuffer, pos, len));
    pos += len;
    // Avoid RegExp.prototype.test: mutable same-realm methods cannot become
    // admission oracles for malformed names.
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      const letter = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
      if (!letter && c !== '_' && (i === 0 || c < '0' || c > '9'))
        throw new TypeError('EXPORT_MANIFEST_NAME');
    }
    return value;
  }
  const count = uleb();
  if (count > 1024) throw new TypeError('EXPORT_MANIFEST_COUNT');
  // Intrinsic-prototype mutations must not disable duplicate admission.
  // A replacement Object.create could return a prototype-bearing object and
  // let duplicate '__proto__' names pass unnoticed.
  const seen = nativeCreate(null);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const exportedName = name();
    if (seen[exportedName] === true) throw new TypeError('EXPORT_MANIFEST_DUPLICATE_NAME');
    seen[exportedName] = true;
    const kind = kinds[byte()];
    const visibility = visibilities[byte()];
    if (!kind || !visibility) throw new TypeError('EXPORT_MANIFEST_ENUM');
    entries[entries.length] = nativeFreeze({name: exportedName, kind, visibility});
  }
  if (pos !== bytes.length) throw new TypeError('EXPORT_MANIFEST_TRAILING_BYTES');
  return nativeFreeze(entries);
}

/**
 * Selection for a public ABI surface only. Never use this function to
 * authorize cross-package imports of package-only declarations.
 */
export function listPublicDeclarativeExports(module) {
  // Do not delegate an authorization filter to mutable Array.prototype.filter.
  const entries = readDeclarativeExports(module);
  const publicEntries = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].visibility === 'public')
      publicEntries[publicEntries.length] = entries[i];
  }
  return nativeFreeze(publicEntries);
}
