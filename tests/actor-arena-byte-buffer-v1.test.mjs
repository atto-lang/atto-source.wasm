import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorArena} from '../src/actor-arena.mjs';

// Host actor arena only: this is not a compiled Atto std.buffer guest.
test('owned arena endian u32 round trip and zero initial bytes', () => {
  const a = new ActorArena({actorId: 501, incarnation: 2});
  const turn = a.beginTurn();
  const handle = a.allocPersistent(turn, 8);
  for (const endian of ['le','be']) {
    a.writeUnsigned(turn, handle, 0, 4, 0x12345678, endian);
    assert.equal(a.readUnsigned(turn, handle, 0, 4, endian), 0x12345678);
    assert.equal(a.readUnsigned(turn, handle, 4, 4, endian), 0);
    assert.deepEqual([...a.read(turn, handle)].slice(0,4),
      endian === 'le' ? [0x78,0x56,0x34,0x12] : [0x12,0x34,0x56,0x78]);
  }
  a.endTurn(turn);
  a.retire();
});

test('byte accesses use exact bounds and error before mutating', () => {
  const a = new ActorArena({actorId: 502, incarnation: 1});
  const turn = a.beginTurn(), handle = a.allocPersistent(turn, 8);
  a.writeUnsigned(turn, handle, 1, 4, 0x12345678, 'le');
  const before = a.read(turn, handle);
  for (const index of [-1, 5, 2**53-1, Number.MAX_VALUE, NaN, 0.5, -Infinity]) {
    assert.throws(() => a.writeUnsigned(turn, handle, index, 4, 42, 'le'), RangeError);
    assert.throws(() => a.readUnsigned(turn, handle, index, 4, 'le'), RangeError);
    assert.deepEqual(a.read(turn, handle), before);
  }
  for (const value of [-1, 4294967296, Infinity, NaN, 1.25, '42']) {
    assert.throws(() => a.writeUnsigned(turn, handle, 1, 4, value, 'le'), RangeError);
    assert.deepEqual(a.read(turn, handle), before);
  }
  for (const width of [0,3,8]) {
    assert.throws(() => a.writeUnsigned(turn, handle, 0, width, 1, 'le'), RangeError);
  }
  for (const order of ['native','BE',null,undefined]) {
    assert.throws(() => a.writeUnsigned(turn, handle, 0, 4, 1, order), TypeError);
  }
  a.endTurn(turn);
  a.retire();
});

test('actor arena opaque handles, turn identity, and drops prevent foreign access', () => {
  const a = new ActorArena({actorId: 503, incarnation: 1});
  const b = new ActorArena({actorId: 503, incarnation: 1});
  const ta = a.beginTurn(), tb = b.beginTurn();
  const owned = a.allocPersistent(ta, 8), foreign = b.allocPersistent(tb, 8);
  a.writeUnsigned(ta, owned, 4, 4, 4294967295, 'le');
  assert.equal(a.readUnsigned(ta, owned, 4, 4, 'le'), 4294967295);
  assert.throws(() => b.readUnsigned(tb, owned, 0, 4, 'le'), /foreign|stale/);
  assert.throws(() => a.writeUnsigned(ta, foreign, 0, 4, 1, 'le'), /foreign|stale/);
  a.dropPersistent(ta, owned);
  assert.throws(() => a.readUnsigned(ta, owned, 0, 1, 'le'), /foreign|stale/);
  a.endTurn(ta);
  assert.throws(() => a.readUnsigned(ta, owned, 0, 1, 'le'), /turn authority/);
  b.endTurn(tb);
  a.retire(); b.retire();
});

test('100k deterministic u32 byte reads preserve full unsigned range', () => {
  const a = new ActorArena({actorId: 504, incarnation: 1});
  const turn = a.beginTurn(), handle = a.allocPersistent(turn, 9);
  let seed = 0x12345678;
  for (let i=0;i<100_000;i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const endian = i%2 ? 'be' : 'le';
    a.writeUnsigned(turn, handle, 3, 4, seed, endian);
    assert.equal(a.readUnsigned(turn, handle, 3, 4, endian), seed);
  }
  a.endTurn(turn);
  a.retire();
});
