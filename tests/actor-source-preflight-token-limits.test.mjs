import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedActorThreadSource} from '../src/actor-max-threads-source-policy.mjs';

const bytes=s=>new TextEncoder().encode(s);
const admit=s=>rejectUnsupportedActorThreadSource(bytes(s));
// Scalar source preflight only: no compiled actor scheduler or guest parity.
test('exactly 100000 harmless tokens pass and the next token fails',()=>{
 assert.doesNotThrow(()=>admit('a '.repeat(100000)));
 assert.throws(()=>admit('a '.repeat(100001)),/source token budget exceeded/);
});

test('nested comments admit depth 128 and reject 129',()=>{
 admit('/*'.repeat(128)+'*/'.repeat(128));
 assert.throws(()=>admit('/*'.repeat(129)+'*/'.repeat(129)),
   /source comment nesting exceeded/);
});

test('CR and NEL comment boundaries cannot hide actor or supervisor declarations',()=>{
 for(const separator of ['\r','\n','\u0085','\u2028','\u2029']){
  assert.throws(()=>admit('// ignored actor'+separator+'define actor Worker as end'),
    /WASM source actor execution unsupported/,JSON.stringify(separator));
  assert.throws(()=>admit('// ignored supervisor'+separator+'define supervisor Root as end'),
    /WASM source supervisor unsupported/,JSON.stringify(separator));
 }
});

test('quoted fake declarations stay inert; reserved enum remains denied',()=>{
 admit('"define actor Fake as end"');
 admit('/* define supervisor Fake as end */ fnc main():int{return 42;}');
 assert.throws(()=>admit('define pub enum MaxActorThreads as end'),
   /built-in MaxActorThreads enum unsupported/);
});
