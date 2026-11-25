import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedActorThreadSource} from '../src/actor-max-threads-source-policy.mjs';

const bytes=source=>new TextEncoder().encode(source);
const admit=source=>rejectUnsupportedActorThreadSource(bytes(source));

test('quoted and nested-comment lookalikes are not executable actor declarations',()=>{
 for(const source of [
  'fnc main(): int { return 1; }',
  '// define actor Hidden {}\nfnc main(): int { return 1; }',
  '/* define /* actor Hidden */ supervisor Spy {} */ fnc main(): int { return 1; }',
  'fnc main(): int { string note = "define actor Hidden"; return 1; }',
  'fnc main(): int { actor.send(); return 1; }'
 ])assert.doesNotThrow(()=>admit(source));
});

test('real actor and supervisor declarations cannot pass as scalar-only Wasm',()=>{
 for(const source of [
  'define actor Runner {}','define shared isoactor Runner {}',
  'define pub supervisor Root {}','supervisor Root { }',
  '@ActorMaxThreads(4) define fnc main() {}',
  'define pub enum MaxActorThreads { One }'
 ])assert.throws(()=>admit(source),/WASM (source actor|source supervisor|built-in MaxActorThreads|source actor @ActorMaxThreads)/);
});

test('ETS and actor-group operations require unavailable runtime capabilities',()=>{
 for(const source of ['ets.lookup(key)','pg.join(group)'])
  assert.throws(()=>admit(source),/WASM (ETS|pg) guest/);
 assert.doesNotThrow(()=>admit('fnc main(): int { int ets = 1; int pg = 2; return ets; }'));
});

test('NUL and oversized source fail before compilation or staged artifact admission',()=>{
 assert.throws(()=>admit('fnc main() {\u0000return 1; }'),/contains NUL byte/);
 assert.throws(()=>rejectUnsupportedActorThreadSource(new Uint8Array(1048577)),/exceeds 1 MiB/);
});