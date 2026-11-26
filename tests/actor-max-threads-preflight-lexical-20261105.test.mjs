import test from 'node:test';
import assert from 'node:assert/strict';
import {rejectUnsupportedActorThreadSource as scan}
 from '../src/actor-max-threads-source-policy.mjs';

const check=s=>scan(new TextEncoder().encode(s));

test('guest actor, supervisor and thread-maximum declarations fail before scalar lowering',()=>{
 for(const text of [
  '@ActorMaxThreads(2)\nfnc main() {}',
  'define pub shared actor Counter {}',
  'define private supervisor Keeper {}',
  'define enum MaxActorThreads { Two }',
  'actor fnc work() {}',
  'ets.open(1)',
  'pg.join("group")'
 ]){
  assert.throws(()=>check(text),/unsupported/);
 }
});

test('quoted keywords, nested block comments and Unicode line endings do not hide live code',()=>{
 assert.doesNotThrow(()=>check('fnc main() { let s = "define actor X {}"; }'));
 assert.doesNotThrow(()=>check('/* outer /* define actor X {} */ still */ fnc main() {}'));
 assert.doesNotThrow(()=>check('// define actor Hidden {}\u0085fnc main() {}'));
 for(const eol of ['\u0085','\u2028','\u2029','\r']){
  assert.throws(()=>check('// ignored'+eol+'define actor Live {}'),/actor execution unsupported/);
 }
});

test('malformed native byte admission fails before scanning untrusted lexical input',()=>{
 assert.throws(()=>scan(new Uint8Array(1_048_577)),/1 MiB byte budget/);
 assert.throws(()=>scan(Uint8Array.of(0x61,0x00,0x62)),/NUL byte/);
 assert.throws(()=>scan(Uint8Array.of(0xff)),/encoded|valid|UTF-8|encoding|decode|malformed|fatal/i);
 assert.throws(()=>scan('define actor X {}'),/immutable snapshot bytes/);
});

test('new elastic actor scheduling syntax fails closed before scalar Wasm delegate',()=>{
  for (const source of [
    '@actor_schedule(max_parallelism = pool_size)\nfnc main() {}',
    '@ActorSchedule(max_parallelism=2) fnc main() {}',
    'spawn Worker() with schedule(max_parallelism=2);'
  ]) assert.throws(() => check(source), /actor scheduling unsupported/);
  assert.doesNotThrow(() => check(
    'fnc main() { let s = "@actor_schedule(max_parallelism = pool_size)"; }'));
  assert.doesNotThrow(() => check(
    '/* @actor_schedule(max_parallelism=2) */ fnc main() {}'));
  assert.throws(() => check('// ignored\u0085@actor_schedule(max_parallelism=2)'),
    /actor scheduling unsupported/);
});
