import test from 'node:test';
import assert from 'node:assert/strict';
import {inferParking,parkingPolicy} from '../src/runtime-parking-effects.mjs';
const node=(direct,calls=[])=>Object.freeze({direct,calls:Object.freeze(calls)});
test('all effect combinations propagate independently across a caller edge',()=>{
  for(let a=0;a<8;a++)for(let b=0;b<8;b++){
    const rows=inferParking(Object.freeze([node(a,[1]),node(b)]));
    assert.deepEqual([...rows],[a|b,b]);
    assert.deepEqual(parkingPolicy(rows[0]),{
      requiresResumableFrame:(a|b)!==0,
      requiresSuspendAnnotation:!!((a|b)&1),
      safeWithExclusiveLoan:(a|b)===0
    });
  }
});
test('maximum cyclic graph propagates all three bits and rejects one extra edge',()=>{
  const graph=Array.from({length:1024},(_,i)=>node(i===0?1:i===511?2:0,
    Array.from({length:16},(_,j)=>i===1023&&j===15?null:(i+1)%1024)));
  assert.ok(inferParking(Object.freeze(graph)).every(bits=>bits===7));
  const oversized=graph.slice();oversized[0]=node(1,[...graph[0].calls,1]);
  assert.throws(()=>inferParking(oversized),/parking edge budget/);
});
test('directed edges, isolated components and renumbering preserve locality',()=>{
  const graph=[node(0,[1,1]),node(0,[2]),node(2,[1]),node(1,[null]),node(0),node(0,[3])];
  const expected=[2,2,2,5,0,5];
  assert.deepEqual([...inferParking(graph)],expected);
  const order=[5,2,4,1,3,0];
  const remapped=order.map(old=>node(graph[old].direct,graph[old].calls.map(t=>t===null?null:order.indexOf(t))));
  assert.deepEqual([...inferParking(remapped)],order.map(i=>expected[i]));
  assert.deepEqual([...inferParking([])],[]);
  const rows=inferParking(graph);rows.fill(7);
  assert.deepEqual([...inferParking(graph)],expected);
});
