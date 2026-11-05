import test from 'node:test';
import assert from 'node:assert/strict';
import {actorRouteHash64,ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

function referenceHash(key){
 let h=0xcbf29ce484222325n;
 for(const byte of new TextEncoder().encode(key))
  h=((h^BigInt(byte))*0x100000001b3n)&0xffffffffffffffffn;
 return h;
}
function fixture(){
 return new ActorPipelinePolicy([
  {id:'src',type:'Source',role:'readable',outbound:'Event'},
  {id:'a',type:'Sink',role:'writable',inbound:'Event'},
  {id:'b',type:'Sink',role:'writable',inbound:'Event'}
 ],[
  {source:'src',target:'a',payload:'Event'},
  {source:'src',target:'b',payload:'Event'}
 ]);
}
test('route hash follows UTF-8 bytes across combining and astral text',()=>{
 for(const key of ['','A','é','e\u0301','🧪','a\0b'])
  assert.equal(actorRouteHash64(key),referenceHash(key));
});
test('keyed routing preserves round-robin initial state',()=>{
 const p=fixture(),routes=p.forwardAll('src');
 for(const key of ['é','e\u0301','🧪'])
  assert.strictEqual(p.forwardByKey('src',key),routes[Number(referenceHash(key)%BigInt(routes.length))]);
 assert.equal(p.forwardRoundRobin('src').target,'a');
});
test('lone surrogates cannot silently route as replacement Unicode',()=>{
 for(const key of ['\ud800','\udc00','ok\ud800tail'])
  assert.throws(()=>actorRouteHash64(key),/invalid Unicode/);
});
