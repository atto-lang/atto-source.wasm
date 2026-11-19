import test from 'node:test';
import assert from 'node:assert/strict';
import {actorRouteHash64} from '../src/actor-pipeline-policy.mjs';

const MASK=(1n<<64n)-1n;
const ref=s=>{
 let h=0xcbf29ce484222325n;
 for(const byte of new TextEncoder().encode(s))
  h=((h^BigInt(byte))*0x100000001b3n)&MASK;
 return h;
};

test('route hash matches an independent FNV-1a reference across UTF-8 boundaries',()=>{
 for(const key of ['', 'a', 'route-42', 'é', 'e\u0301', '😀', 'a\0b', '東京', 'é'.repeat(2048)]){
  assert.equal(actorRouteHash64(key),ref(key),JSON.stringify(key));
  assert.equal(actorRouteHash64(key),actorRouteHash64(key));
 }
 assert.notEqual(actorRouteHash64('é'),actorRouteHash64('e\u0301'),
   'the routing hash preserves exact UTF-8 identity rather than normalizing');
});

test('route hashing rejects malformed surrogate and overbudget UTF-8 input',()=>{
 for(const value of ['\ud800','\udc00','hello\ud800world'])
  assert.throws(()=>actorRouteHash64(value),/invalid Unicode/);
 assert.throws(()=>actorRouteHash64('a'.repeat(4097)),/pipeline byte limit/);
 assert.throws(()=>actorRouteHash64('é'.repeat(2049)),/pipeline UTF-8 byte budget/);
 assert.throws(()=>actorRouteHash64(42),/invalid pipeline identifier/);
});