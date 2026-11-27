import test from 'node:test';
import assert from 'node:assert/strict';
import {inferParking,parkingPolicy} from '../src/runtime-parking-effects.mjs';
const node=(direct,calls=[])=>({direct,calls});
test('recursive parking and explicit suspend remain independent',()=>{
  assert.deepEqual([...inferParking([node(0,[1]),node(0,[0,2]),node(2),node(1,[2]),node(0,[null]),node(0,[4]),node(0)])],[2,2,2,3,4,4,0]);
  assert.deepEqual(parkingPolicy(2),{requiresResumableFrame:true,requiresSuspendAnnotation:false,safeWithExclusiveLoan:false});
  assert.equal(parkingPolicy(3).requiresSuspendAnnotation,true);
  assert.equal(parkingPolicy(0).safeWithExclusiveLoan,true);
});
test('invalid resolved IDs, malformed facts and budgets fail closed',()=>{
  for(const target of [-1,1,NaN,undefined,'0',0.5])assert.throws(()=>inferParking([node(0,[target])]));
  for(const bits of [-1,8,NaN,'2',1.5])assert.throws(()=>inferParking([node(bits)]));
  assert.throws(()=>inferParking(Array.from({length:1025},()=>node(0))));
  assert.throws(()=>inferParking([node(0,Array(1025).fill(null))]));
  assert.throws(()=>inferParking(Array.from({length:17},()=>node(0,Array(1024).fill(null)))));
});
test('256 deterministic reachability oracle trials and exact graph budget',()=>{
  let seed=1127n;
  const next=m=>{seed=BigInt.asUintN(64,seed*6364136223846793005n+1n);return Number((seed>>32n)%BigInt(m));};
  for(let trial=0;trial<256;trial++){
    const n=1+next(48);
    const graph=Array.from({length:n},()=>{const b=next(16);return node(b===1?1:b===2?2:b===3?4:0,Array.from({length:next(8)},()=>{const t=next(n+3);return t<n?t:null;}));});
    const actual=inferParking(graph);
    for(let root=0;root<n;root++){
      const seen=new Set(), todo=[root];let expected=0;
      while(todo.length){const i=todo.pop();if(seen.has(i))continue;seen.add(i);expected|=graph[i].direct;for(const t of graph[i].calls){if(t===null)expected|=4;else todo.push(t);}}
      assert.equal(actual[root],expected);
    }
  }
  const full=Array.from({length:1024},(_,i)=>node(i===1023?2:0,Array(16).fill((i+1)%1024)));
  assert.ok(inferParking(full).every(x=>x===2));
});
