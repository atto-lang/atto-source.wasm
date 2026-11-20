// Wasm bridge source admission, NOT compiled Atto guest/runtime proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {rejectMutexResourceClassSource} from '../scripts/compile-ores.mjs';

const bytes=text=>new TextEncoder().encode(text);
const fixture=name=>readFileSync(new URL('../fixtures/mutex_constructor/'+name,import.meta.url));

test('bare resource class invocation rejects with E_NEW_REQUIRED',()=>{
  assert.throws(()=>rejectMutexResourceClassSource(fixture('reject-bare.atto')),
    /E_NEW_REQUIRED/);
});
test('canonical new remains unsupported until Wasm mutex guest runtime exists',()=>{
  assert.throws(()=>rejectMutexResourceClassSource(fixture('reject-unlowered-new.atto')),
    /E_LOCK_UNSUPPORTED/);
});
test('comment/string text cannot trick constructor admission',()=>{
  const source=bytes('// Mutex<int>(0) old constructor\\n/* new Mutex<int>(0) */\\n'
      +'pub fnc main(): int { val src = \"Mutex<int>(0)\"; return 42; }');
  assert.doesNotThrow(()=>rejectMutexResourceClassSource(source));
});
test('nested generic constructor matches precisely; type reference is not construction',()=>{
  assert.throws(()=>rejectMutexResourceClassSource(bytes('new Mutex<Result<int,string>>(0)')),
    /E_LOCK_UNSUPPORTED/);
  assert.throws(()=>rejectMutexResourceClassSource(bytes('Mutex<Result<int,string>>(0)')),
    /E_NEW_REQUIRED/);
  assert.doesNotThrow(()=>rejectMutexResourceClassSource(bytes('fnc f(Mutex<int> m): int {return 1;}')));
  assert.doesNotThrow(()=>rejectMutexResourceClassSource(bytes('Point(x=1,y=2)')));
});
