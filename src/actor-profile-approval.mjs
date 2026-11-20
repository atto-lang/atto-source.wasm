import {createPublicKey, verify} from 'node:crypto';
import {types} from 'node:util';
import {ACTOR_FRAME_PROFILES} from '../scripts/actor-frame-profile.mjs';

// Signed host approval, not an assertion derived from untrusted guest bytes.
// The trusted operator must provision the Ed25519 verification key outside the
// guest and independently authenticate compiler-source and binary provenance.
const KEYS = Object.freeze([
  'schema', 'profile', 'wasmSha256', 'sourceSha256',
  'compilerSha256', 'llvmIrSha256', 'actorFrameCells', 'actorAbi'
]);
const SIGNED = Object.freeze([...KEYS, 'signature']);
const HEX = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]{86}$/;
const supported = new Set(Object.values(ACTOR_FRAME_PROFILES));

function snapshotData(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw TypeError('actor artifact approval must be a plain data record');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expectedKeys.length ||
      !keys.every(k => typeof k === 'string' && expectedKeys.includes(k)))
    throw TypeError('actor artifact approval has missing or unexpected fields');
  const data = Object.create(null);
  for (const key of expectedKeys) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !Object.hasOwn(desc, 'value'))
      throw TypeError('actor artifact approval accessors are not permitted');
    data[key] = desc.value;
  }
  return data;
}

function checkedStatement(value) {
  const x = snapshotData(value, KEYS);
  if (x.schema !== 1 || !supported.has(x.profile) ||
      x.actorAbi !== 'pooled-actor-i64-v0' ||
      !Number.isSafeInteger(x.actorFrameCells) ||
      (x.profile === ACTOR_FRAME_PROFILES.SCALAR
        ? x.actorFrameCells < 2 || x.actorFrameCells > 17
        : x.actorFrameCells !== 64) ||
      ![x.wasmSha256,x.sourceSha256,x.compilerSha256,x.llvmIrSha256]
        .every(y => typeof y === 'string' && HEX.test(y)))
    throw TypeError('invalid versioned actor artifact approval statement');
  // Fixed-order, domain-separated ASCII, no JSON serialization ambiguities.
  const msg = ['atto-wasm-actor-profile-approval-v1', ...KEYS.map(k => String(x[k]))]
    .join('\n') + '\n';
  return {x, bytes: Buffer.from(msg, 'utf8')};
}

// Offline signer input. Calling this function does NOT authorize an artifact.
export function actorProfileApprovalPayload(statement) {
  return checkedStatement(statement).bytes;
}

export function verifySignedActorProfileApproval(approval, expectedWasmSha256, key) {
  if (typeof expectedWasmSha256 !== 'string' || !HEX.test(expectedWasmSha256))
    throw TypeError('pinned Wasm SHA-256 required for actor approval');
  const x = snapshotData(approval, SIGNED);
  const statement = Object.fromEntries(KEYS.map(k => [k, x[k]]));
  const {bytes} = checkedStatement(statement);
  if (statement.wasmSha256 !== expectedWasmSha256)
    throw Error('actor profile approval is bound to another Wasm binary');
  if (typeof x.signature !== 'string' || !BASE64URL.test(x.signature))
    throw Error('invalid actor profile approval signature encoding');
  const signature = Buffer.from(x.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== x.signature)
    throw Error('noncanonical actor profile approval signature');
  const publicKey = createPublicKey(key);
  if (publicKey.asymmetricKeyType !== 'ed25519')
    throw TypeError('actor profile approval requires trusted Ed25519 key');
  if (!verify(null, bytes, publicKey, signature))
    throw Error('actor profile signature verification failed');
  return Object.freeze({
    profile: statement.profile,
    wasmSha256: statement.wasmSha256,
    compilerSha256: statement.compilerSha256,
    llvmIrSha256: statement.llvmIrSha256,
    sourceSha256: statement.sourceSha256,
    actorFrameCells: statement.actorFrameCells
  });
}
