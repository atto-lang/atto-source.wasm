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

test('actor incarnation is unique while leased and memory.grow prototype spoofing fails', () => {
  const manager=pool(3); const a=manager.lease(11,4);
  assert.throws(()=>manager.lease(11,4), /already leased/);
  assert.throws(()=>manager.lease(11,5), /already leased/);
  const t=a.beginTurn(); const root=a.allocate(t,8);
  a.write(t,root,new Uint8Array(8).fill(23));
  const grow = WebAssembly.Memory.prototype.grow;
  try {
    WebAssembly.Memory.prototype.grow = function () { throw new Error('poisoned grow'); };
    const next=a.allocate(t,65536);
    assert.equal(a.committedPages,2);
    assert.equal(a.read(t,root)[0],23);
    assert.equal(a.read(t,next)[0],0);
  } finally {
    WebAssembly.Memory.prototype.grow = grow;
  }
  a.endTurn(t); a.retire();
  const b=manager.lease(11,4); // prior incarnation identity is no longer active.
  const tb=b.beginTurn(); b.endTurn(tb); b.retire(); manager.retire();
});

test('seeded churn: grow/drop/reuse preserves values and isolation under a hard cap', () => {
  const manager=pool(4,4); const a=manager.lease(81,1), t=a.beginTurn();
  let seed=0x12345678;
  const rng=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const live=[];
  for(let i=0;i<4000;i++) {
    const shouldDrop=live.length>0 && (live.length>70 || rng()%3===0);
    if(shouldDrop) {
      const index=rng()%live.length; const entry=live.splice(index,1)[0];
      assert.equal(a.read(t,entry.handle)[0],entry.value);
      a.drop(t,entry.handle);
      assert.throws(()=>a.read(t,entry.handle),/foreign or stale/);
    } else {
      const length=1+(rng()%1024);
      try {
        const handle=a.allocate(t,length);
        const value=(rng()%254)+1;
        a.write(t,handle,new Uint8Array(length).fill(value));
        live.push({handle,value});
      } catch(error) {
        assert.match(String(error),/hard quota|page budget/);
        assert.ok(manager.chargedPages<=4);
      }
    }
    if(live.length && i%31===0) {
      const probe=live[rng()%live.length];
      assert.equal(a.read(t,probe.handle)[0],probe.value);
    }
  }
  for(const entry of live) {
    assert.equal(a.read(t,entry.handle)[0],entry.value);
    a.drop(t,entry.handle);
  }
  assert.equal(a.liveAllocations,0);
  assert.ok(manager.chargedPages<=4);
  assert.throws(()=>manager.retire(),/still active/);
  a.endTurn(t); a.retire();
  const b=manager.lease(81,2),tb=b.beginTurn();
  const fresh=b.allocate(tb,512);
  assert.deepEqual([...b.read(tb,fresh)],Array(512).fill(0));
  b.endTurn(tb); b.retire(); manager.retire();
});
