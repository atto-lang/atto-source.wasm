import test from 'node:test';
import assert from 'node:assert/strict';
import {ElasticActorHeapPoolV1, ElasticHeapPageLedgerV1} from '../src/elastic-actor-heap-v1.mjs';

function pool(maxPages, budgetPages = maxPages) {
  return new ElasticActorHeapPoolV1({maxPages, processLedger: new ElasticHeapPageLedgerV1(budgetPages), tenantLedger: new ElasticHeapPageLedgerV1(maxPages * 16)});
}

test('zero initial commitment, exact actor offsets, and growth preserves live bytes', () => {
  const manager = pool(4); const a = manager.lease(1, 1); const t = a.beginTurn();
  assert.equal(a.committedPages, 0);
  const root = a.allocate(t, 32);
  assert.equal(a.word(t, root), 1); assert.equal(a.committedPages, 1);
  a.write(t, root, new Uint8Array(32).fill(47));
  const next = a.allocate(t, 70000);
  assert.equal(a.committedPages, 2);
  assert.equal(a.word(t, next), 5);
  assert.deepEqual([...a.read(t, root)], Array(32).fill(47));
  assert.deepEqual([...a.read(t, next).subarray(0,8)], Array(8).fill(0));
  assert.equal(manager.chargedPages, 2);
  const copy = a.read(t, root); copy[0] = 88;
  assert.equal(a.read(t, root)[0], 47, 'read never exports a live view');
  a.endTurn(t); a.retire(); manager.retire();
});

test('per-process quota denial is atomic; sibling actor survives', () => {
  const manager = pool(4, 2);
  const a = manager.lease(1, 1), b = manager.lease(2, 1);
  const ta = a.beginTurn(), tb = b.beginTurn();
  const ha = a.allocate(ta, 64); const hb = b.allocate(tb, 64);
  a.write(ta, ha, new Uint8Array(64).fill(11));
  b.write(tb, hb, new Uint8Array(64).fill(22));
  assert.equal(manager.chargedPages, 2);
  assert.throws(()=>a.allocate(ta, 65536), /process page budget/);
  assert.equal(a.committedPages,1); assert.equal(a.liveAllocations,1);
  assert.equal(a.read(ta,ha)[0],11);
  assert.equal(b.read(tb,hb)[0],22);
  assert.throws(()=>b.read(tb,ha), /foreign or stale/);
  a.endTurn(ta); b.endTurn(tb); a.retire(); b.retire();
  assert.equal(manager.chargedPages, 2, 'no optimistic physical refund on retirement');
  manager.retire();
});

test('scrubbed pool reuse denies stale handles and retains already charged pages', () => {
  const manager=pool(2,1); const a=manager.lease(1,1); const ta=a.beginTurn();
  const old=a.allocate(ta,65536); a.write(ta, old,new Uint8Array(65536).fill(93));
  a.endTurn(ta); a.retire();
  assert.equal(manager.idleCount,1);
  const b=manager.lease(1,2), tb=b.beginTurn();
  assert.equal(b.committedPages,1);
  assert.throws(()=>b.read(tb,old),/foreign or stale/);
  const fresh=b.allocate(tb,64);
  assert.equal(b.read(tb,fresh)[0],0);
  assert.equal(manager.chargedPages,1);
  assert.throws(()=>b.allocate(tb,65536),/process page budget/);
  b.endTurn(tb); b.retire(); manager.retire();
});

test('drop zeroes bytes, reuses allocation, and rejects stale and foreign turns',()=>{
  const manager=pool(2); const a=manager.lease(1,1), b=manager.lease(2,1);
  const ta=a.beginTurn(), tb=b.beginTurn();
  const h=a.allocate(ta,32); a.write(ta,h,new Uint8Array(32).fill(77));
  assert.throws(()=>a.read(tb,h), /foreign actor turn/);
  a.drop(ta,h);
  assert.throws(()=>a.read(ta,h), /foreign or stale/);
  const replacement=a.allocate(ta,32);
  assert.equal(a.word(ta,replacement),1);
  assert.deepEqual([...a.read(ta,replacement)],Array(32).fill(0));
  assert.throws(()=>a.retire(),/active actor turn/);
  a.endTurn(ta); b.endTurn(tb); a.retire(); b.retire(); manager.retire();
});

test('reject forged owner, invalid alignment, oversized payload and shared backing',()=>{
  const manager=pool(1);
  assert.throws(()=>manager.lease(0,1),/invalid actor/);
  const a=manager.lease(1,1), t=a.beginTurn();
  assert.throws(()=>a.allocate(t,0),/invalid actor allocation/);
  assert.throws(()=>a.allocate(t,8,3),/invalid actor allocation/);
  assert.throws(()=>a.allocate(t,65537),/hard quota/);
  const h=a.allocate(t,4);
  assert.throws(()=>a.write(t,h,new Uint8Array(2)),/exact-size/);
  if(typeof SharedArrayBuffer === 'function') {
    assert.throws(()=>a.write(t,h,new Uint8Array(new SharedArrayBuffer(4))),/exact-size/);
  }
  assert.equal(a.read(t,h)[0],0);
  a.endTurn(t); a.retire(); manager.retire();
});

test('tenant budget is independently enforced without bypassing process budget', () => {
  const tenant = new ElasticHeapPageLedgerV1(1);
  const process = new ElasticHeapPageLedgerV1(3);
  const manager = new ElasticActorHeapPoolV1({maxPages:3,tenantLedger:tenant,processLedger:process});
  const a=manager.lease(1,1); const t=a.beginTurn();
  const h=a.allocate(t,16);
  assert.equal(tenant.chargedPages,1); assert.equal(process.chargedPages,1);
  assert.throws(()=>a.allocate(t,65536),/tenant page budget/);
  assert.equal(a.committedPages,1); assert.equal(a.read(t,h)[0],0);
  assert.equal(tenant.chargedPages,1); assert.equal(process.chargedPages,1);
  a.endTurn(t); a.retire(); manager.retire();
});
