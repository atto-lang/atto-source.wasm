// Host-only worker metadata gate, never a guest codec or authority.
// Primitive strings/numbers only: no object getters, coercions, or shared buffers.
function reject(reason) { throw new Error(reason); }
function bit(label) {
  switch (label) {
    case "messagepack": return 1;
    case "protobuf": return 2;
    case "cbor": return 4;
    case "flatbuffers": return 8;
    default: return 0;
  }
}
function mask(n) { return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 15; }
function version(n) { return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 0xffffffff; }
function schema(s) {
  if (typeof s !== "string" || s.length === 0 || s.length > 256) return false;
  for (let i=0;i<s.length;i++) { const c=s.charCodeAt(i); if(c<33 || c>126) return false; }
  return true;
}
function shape(s) { return typeof s === "string" && s.length === 64 && /^[0-9a-f]{64}$/.test(s); }
// Trusted registration only. Support mask is not proof that a codec exists.
export function bindActorDataCodec(requested, allowed, supported, wireVersion, schemaId, shapeHex) {
  if (!mask(allowed) || !mask(supported)) reject("InvalidMask");
  const codec = bit(requested === null ? "messagepack" : requested);
  if (!codec) reject("UnknownCodec");
  if (!(allowed & codec)) reject("Denied");
  if (!(supported & codec)) reject("Unsupported");
  if (!version(wireVersion) || !schema(schemaId) || !shape(shapeHex)) reject("InvalidBinding");
  // A closure captures immutable primitives. It never dispatches using incoming metadata.
  // Trusted worker realm only; not safe to expose this helper to arbitrary host JS.
  return function requireMatch(label, v, id, hash) {
    if (bit(label) !== codec || v !== wireVersion || id !== schemaId || hash !== shapeHex)
      reject("Mismatch");
  };
}
