// Compiler/host-only DATA shape validation. Does NOT mint ActorRef, reply ticket,
// supervisor capability, mailbox, or execution permission.
const encoder = new TextEncoder();
const MAX_STAGES = 1024;
const MAX_BYTES = 256;

function ownData(input, name) {
  if (typeof input !== 'object' || input === null)
    throw new TypeError('actor pipeline stage must be an own-data descriptor');
  const property = Object.getOwnPropertyDescriptor(input, name);
  if (!property || !Object.hasOwn(property, 'value'))
    throw new TypeError('actor pipeline descriptor requires own data: ' + name);
  return property.value;
}

function checkedName(value, optional = false) {
  if (typeof value !== 'string' || (!optional && !value) || value.includes('\0'))
    throw new TypeError('invalid actor pipeline identifier or payload');
  // Bound code units before scanning to avoid excessive work on huge inputs.
  if (value.length > MAX_BYTES) throw new RangeError('actor pipeline name byte budget');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++i >= value.length || value.charCodeAt(i) < 0xdc00 ||
          value.charCodeAt(i) > 0xdfff)
        throw new TypeError('malformed actor pipeline Unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff)
      throw new TypeError('malformed actor pipeline Unicode');
  }
  if (encoder.encode(value).length > MAX_BYTES)
    throw new RangeError('actor pipeline UTF-8 byte budget');
  return value;
}

function stageShape(input) {
  const s = Object.freeze({
    id: checkedName(ownData(input, 'id')),
    actorType: checkedName(ownData(input, 'actorType')),
    role: ownData(input, 'role'),
    forwardIn: checkedName(ownData(input, 'forwardIn'), true),
    forwardOut: checkedName(ownData(input, 'forwardOut'), true),
    backwardIn: checkedName(ownData(input, 'backwardIn'), true),
    backwardOut: checkedName(ownData(input, 'backwardOut'), true)
  });
  if (!((s.role === 'readable' && !s.forwardIn && s.forwardOut) ||
        (s.role === 'writable' && s.forwardIn && !s.forwardOut) ||
        (s.role === 'transform' && s.forwardIn && s.forwardOut)))
    throw new TypeError('invalid actor pipeline forward role');
  return s;
}

export function planActorBidirectionalMetadata(stages) {
  if (!Array.isArray(stages) || stages.length < 2 || stages.length > MAX_STAGES)
    throw new RangeError('actor factory stage budget');
  const count = stages.length, snapshot = new Array(count), seen = new Set();
  for (let i = 0; i < count; i++) {
    const s = stageShape(ownData(stages, String(i)));
    if (seen.has(s.id)) throw new TypeError('duplicate actor pipeline stage');
    seen.add(s.id);
    snapshot[i] = s;
  }
  if (snapshot[0].role !== 'readable' || snapshot[count - 1].role !== 'writable')
    throw new TypeError('actor pipeline requires readable source and writable sink');
  const forward = new Array(count), reverse = new Array(count - 1);
  const hasBackward = snapshot.some(s => s.backwardIn !== '' || s.backwardOut !== '');
  for (let i = 0; i < count; i++) {
    const s = snapshot[i];
    if (hasBackward) {
      const valid = (i === 0 && !!s.backwardIn && !s.backwardOut) ||
        (i === count - 1 && !s.backwardIn && !!s.backwardOut) ||
        (i > 0 && i < count - 1 && !!s.backwardIn && !!s.backwardOut);
      if (!valid) throw new TypeError('incomplete actor pipeline reverse reply ports');
    } else if (s.backwardIn || s.backwardOut)
      throw new TypeError('unexpected actor reverse port');
    forward[i] = Object.freeze({id:s.id, actorType:s.actorType, role:s.role,
      inbound:s.forwardIn, outbound:s.forwardOut});
    if (i === 0) continue;
    const upstream = snapshot[i - 1];
    if (!upstream.forwardOut || upstream.forwardOut !== s.forwardIn)
      throw new TypeError('incompatible forward DATA ports');
    if (hasBackward) {
      if (s.backwardOut !== upstream.backwardIn)
        throw new TypeError('incompatible reverse reply DATA ports');
      reverse[i - 1] = Object.freeze({source:s.id, target:upstream.id,
        payload:s.backwardOut});
    }
  }
  return Object.freeze({
    forwardStages:Object.freeze(forward),
    reverseEdges:Object.freeze(hasBackward ? reverse : []),
    backwardEnabled:hasBackward,
    // A type-level obligation, never evidence that tickets are issued or verified.
    reversePolicy:hasBackward ? 'REQUIRES_RUNTIME_CORRELATION_AND_GENERATION_FENCING' : 'NO_REVERSE_DATA'
  });
}
