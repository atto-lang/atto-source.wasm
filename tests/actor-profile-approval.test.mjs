import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {
  actorProfileApprovalPayload, verifySignedActorProfileApproval
} from '../src/actor-profile-approval.mjs';
import {ACTOR_FRAME_PROFILES} from '../scripts/actor-frame-profile.mjs';

const hash = n => String(n).repeat(64);
const statement = (profile=ACTOR_FRAME_PROFILES.SCALAR, cells=5) => ({
  schema: 1, profile, wasmSha256: hash('a'),
  sourceSha256: hash('b'), compilerSha256: hash('c'),
  llvmIrSha256: hash('d'), actorFrameCells: cells,
  actorAbi: 'pooled-actor-i64-v0'
});
const keys = () => generateKeyPairSync('ed25519');
const approve = (s, privateKey) => ({
  ...s, signature: sign(null, actorProfileApprovalPayload(s), privateKey).toString('base64url')
});

test('trusted Ed25519 signer binds profile, Wasm, source, IR and compiler binary', () => {
  const {publicKey,privateKey} = keys();
  for (const [profile,cells] of [[ACTOR_FRAME_PROFILES.SCALAR,2],
                                 [ACTOR_FRAME_PROFILES.SCALAR,17],
                                 [ACTOR_FRAME_PROFILES.STACK64,64]]) {
    const s = statement(profile,cells);
    const sealed = approve(s, privateKey);
    const verified = verifySignedActorProfileApproval(sealed, s.wasmSha256, publicKey);
    assert.equal(verified.profile, profile);
    assert.equal(verified.actorFrameCells, cells);
    assert.equal(verified.wasmSha256, s.wasmSha256);
    assert.equal(Object.isFrozen(verified), true);
    assert.throws(() => verifySignedActorProfileApproval(sealed,hash('e'),publicKey),/another Wasm/);
    const other = keys();
    assert.throws(() => verifySignedActorProfileApproval(sealed,s.wasmSha256,other.publicKey),
      /signature verification/);
    for (const field of ['profile','sourceSha256','compilerSha256','llvmIrSha256','actorFrameCells']) {
      const tampered = {...sealed,[field]:field==='actorFrameCells' ? (cells===64?17:64)
        : field==='profile' ? (profile===ACTOR_FRAME_PROFILES.SCALAR
          ? ACTOR_FRAME_PROFILES.STACK64 : ACTOR_FRAME_PROFILES.SCALAR)
        : hash('e')};
      assert.throws(() => verifySignedActorProfileApproval(tampered,s.wasmSha256,publicKey),
        /approval|signature|versioned/);
    }
  }
});

test('forged, noncanonical, proxy and accessor signatures cannot grant actor admission', () => {
  const {publicKey,privateKey}=keys();
  const s=statement();
  const approval=approve(s,privateKey);
  assert.throws(() => verifySignedActorProfileApproval({...approval, extra:1},hash('a'),publicKey),
    /unexpected fields/);
  assert.throws(() => verifySignedActorProfileApproval(new Proxy({...approval},{}),hash('a'),publicKey),
    /plain data record/);
  assert.throws(() => verifySignedActorProfileApproval(
    Object.assign(Object.create({spoofed:true}), approval),hash('a'),publicKey),
    /plain data record/);
  for (const field of Object.keys(approval)) {
    const accessor={...approval};
    Object.defineProperty(accessor,field,{get(){throw Error('untrusted getter');}});
    assert.throws(()=>verifySignedActorProfileApproval(accessor,hash('a'),publicKey),/accessors/);
    const missing={...approval};delete missing[field];
    assert.throws(()=>verifySignedActorProfileApproval(missing,hash('a'),publicKey),/missing/);
  }
  for (const signature of ['x', '+'.repeat(86), approval.signature + '=', 'A'.repeat(86)])
    assert.throws(()=>verifySignedActorProfileApproval({...approval,signature},hash('a'),publicKey),
      /signature/);
  assert.throws(()=>verifySignedActorProfileApproval({...approval,profile:'auto'},hash('a'),publicKey),
    /invalid versioned/);
  assert.throws(()=>actorProfileApprovalPayload(statement(ACTOR_FRAME_PROFILES.STACK64,17)),
    /invalid versioned/);
  assert.throws(()=>actorProfileApprovalPayload(statement(ACTOR_FRAME_PROFILES.SCALAR,64)),
    /invalid versioned/);
});

test('a signed profile statement must not contain extra capabilities or ambiguous hashes', () => {
  const {publicKey,privateKey}=keys();
  const signed=approve(statement(),privateKey);
  for (const field of ['wasmSha256','sourceSha256','compilerSha256','llvmIrSha256'])
    assert.throws(()=>actorProfileApprovalPayload({...statement(),[field]:'F'.repeat(64)}),
      /invalid versioned/);
  assert.throws(()=>verifySignedActorProfileApproval(
    {...signed,actorAbi:'pooled-actor-i64-v2'},hash('a'),publicKey),/versioned/);
  assert.throws(()=>verifySignedActorProfileApproval(signed,'not-a-digest',publicKey),/SHA-256/);
  assert.throws(()=>actorProfileApprovalPayload({...statement(), signature:'extra'}),/unexpected fields/);
});
