// Bounded event-sourcing wire codec for trusted host workers.
// NOT durable storage, actor scheduler integration, or compiled .atto guest.
export const limits = Object.freeze({
  max_events: 256,
  max_batch_bytes: 1048576,
  max_event_bytes: 65536,
  max_command_bytes: 65536,
  max_reply_bytes: 65536,
});
const deny = (reason) => { throw new RangeError('DURABLE_COMMAND_WIRE_V1_' + reason); };
const uint32 = n => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff;
const bytes = (value, max, label) => {
  if (!(value instanceof Uint8Array) || value.byteLength > max) deny(label);
  return Uint8Array.from(value);  // detached from caller/worker-owned bytes
};
const add_u32 = (view, pos, value) => view.setUint32(pos, value, false);

export function encode_event_batch(events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > limits.max_events)
    deny('COUNT');
  const copied = [];
  let length = 4;
  for (const event of events) {
    if (event === null || typeof event !== 'object' || !uint32(event.schema_version))
      deny('SCHEMA');
    const payload = bytes(event.payload, limits.max_event_bytes, 'PAYLOAD');
    length += 8 + payload.byteLength;
    if (length > limits.max_batch_bytes) deny('BATCH_BUDGET');
    copied.push({ schema_version: event.schema_version, payload });
  }
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  add_u32(view, 0, copied.length);
  let offset = 4;
  for (const event of copied) {
    add_u32(view, offset, event.schema_version);
    add_u32(view, offset + 4, event.payload.byteLength);
    out.set(event.payload, offset + 8);
    offset += 8 + event.payload.byteLength;
  }
  return out;
}

export function decode_event_batch(buffer) {
  const source = bytes(buffer, limits.max_batch_bytes, 'BATCH_BUDGET');
  if (source.byteLength < 12) deny('TRUNCATED');
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const count = view.getUint32(0, false);
  if (count < 1 || count > limits.max_events) deny('COUNT');
  const result = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    if (source.byteLength - offset < 8) deny('TRUNCATED');
    const schema_version = view.getUint32(offset, false);
    const length = view.getUint32(offset + 4, false);
    if (!uint32(schema_version)) deny('SCHEMA');
    if (length > limits.max_event_bytes) deny('PAYLOAD');
    offset += 8;
    if (length > source.byteLength - offset) deny('TRUNCATED');
    result.push({ schema_version, payload: source.slice(offset, offset + length) });
    offset += length;
  }
  if (offset !== source.byteLength) deny('TRAILING_BYTES');
  return result;
}

// Host admission only: metadata is never used as a bearer capability.
// Tenant, ActorId, epoch and storage authority MUST come from the supervisor.
export function snapshot_command_envelope(request, reply, events) {
  const owned_request = bytes(request, limits.max_command_bytes, 'COMMAND');
  const owned_reply = bytes(reply, limits.max_reply_bytes, 'REPLY');
  const owned_batch = encode_event_batch(events);
  return { request: owned_request, reply: owned_reply, batch: owned_batch };
}
