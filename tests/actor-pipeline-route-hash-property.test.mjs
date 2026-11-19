import test from 'node:test';
import assert from 'node:assert/strict';
import {actorRouteHash64,ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

// Independent arithmetic form of FNV-1a 64 over canonical UTF-8 bytes.
const mod=1n<<64n;
const reference=text=>{
 let hash=0xcbf29ce484222325n;
 for(const byte of new TextEncoder().encode(text))
  hash=((hash^BigInt(byte))*0x100000001b3n)%mod;
 return hash;
};
const stages=[
 {id:'producer',type:'Source',role:'readable',outbound:'Event'},
 ...['alpha','beta','gamma'].map(id=>({id,type:'Sink',role:'writable',inbound:'Event'}))
];
const edges=['alpha','beta','gamma'].map(target=>({source:'producer',target,payload:'Event'}));

test('seeded UTF-8, NUL and multibyte keys agree with independent FNV oracle',()=>{
 let seed=0x9e3779b9;
 const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
 const alphabet=['a','Z','0','\0','é','界','🌍','\u0301','_','/'];
 for(let trial=0;trial<512;trial++){
  const length=next()%40;
  let key='';
  for(let i=0;i<length;i++)key+=alphabet[next()%alphabet.length];
  assert.equal(actorRouteHash64(key),reference(key),'seeded key '+trial);
 }
});

test('route selection matches independently computed UTF-8 hash buckets',()=>{
 const policy=new ActorPipelinePolicy(stages,edges);
 const destinations=['alpha','beta','gamma'];
 for(const key of ['', '\0', 'a\0b', '🌍', 'e\u0301', 'é', 'source/one']){
  const index=Number(reference(key)%BigInt(destinations.length));
  assert.equal(policy.forwardByKey('producer',key).target,destinations[index],key);
 }
 policy.close();
 assert.throws(()=>policy.forwardByKey('producer','any'),/retired/);
});

test('UTF-8 routing keys are byte-distinct without Unicode normalization',()=>{
 const composed='é',decomposed='e\u0301';
 assert.notEqual(actorRouteHash64(composed),actorRouteHash64(decomposed));
 assert.equal(actorRouteHash64(composed),reference(composed));
 assert.equal(actorRouteHash64(decomposed),reference(decomposed));
});
