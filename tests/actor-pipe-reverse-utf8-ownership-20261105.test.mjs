import test from 'node:test';
import assert from 'node:assert/strict';
import {planActorBidirectionalMetadata as plan} from '../src/actor-pipe-bidirectional-metadata.mjs';

const stages=()=>[
 {id:'source',actorType:'Reader',role:'readable',forwardIn:'',forwardOut:'Work',backwardIn:'Receipt',backwardOut:''},
 {id:'stage',actorType:'Transform',role:'transform',forwardIn:'Work',forwardOut:'Job',backwardIn:'Receipt',backwardOut:'Receipt'},
 {id:'sink',actorType:'Writer',role:'writable',forwardIn:'Job',forwardOut:'',backwardIn:'',backwardOut:'Receipt'}
];

test('reverse-capable actor stage names accept exactly 256 UTF-8 bytes, reject overflow',()=>{
 const names=stages();
 names[1].id='🌍'.repeat(64);
 const admitted=plan(names);
 assert.equal(new TextEncoder().encode(admitted.forwardStages[1].id).length,256);
 assert.equal(admitted.reverseEdges[1].target,names[1].id);
 names[1].id='🌍'.repeat(65);
 assert.throws(()=>plan(names),/UTF-8 byte budget/);
});

test('backward DATA metadata must be inert and cannot change after plan snapshot',()=>{
 const inputs=stages(),planValue=plan(inputs);
 inputs[1].id='forged';
 inputs[1].backwardIn='forged';
 assert.equal(planValue.forwardStages[1].id,'stage');
 assert.equal(planValue.reverseEdges[0].payload,'Receipt');
 assert.ok(Object.isFrozen(planValue.reverseEdges[0]));
 let called=0;
 const hostile=stages();
 Object.defineProperty(hostile[1],'backwardOut',{
  enumerable:true,get(){called++;throw Error('untrusted backward getter');}
 });
 assert.throws(()=>plan(hostile),/own data/);
 assert.equal(called,0);
});

test('one-way stage topology never claims implicit reverse DATA or control authority',()=>{
 const input=stages().map(s=>({...s,backwardIn:'',backwardOut:''}));
 const p=plan(input);
 assert.equal(p.backwardEnabled,false);
 assert.deepEqual(p.reverseEdges,[]);
 assert.equal(p.reversePolicy,'NO_REVERSE_DATA');
 assert.equal(typeof p.send,'undefined');
});
