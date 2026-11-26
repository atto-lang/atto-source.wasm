import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runVerifiedScalarStateSource} from '../src/browser-scalar-state-guest.mjs';
const compilerPath=process.env.ATTO_STATE_COMPILER_WASM;
const digest=process.env.ATTO_STATE_COMPILER_SHA256;
const path=(p)=>new URL('./fixtures/state-intrinsics-v1/'+p,import.meta.url);
const run=async source=>{
  assert.ok(compilerPath&&/^[a-f0-9]{64}$/.test(digest||''),'exact built compiler required; no skip');
  const compilerBytes=await readFile(compilerPath);
  assert.equal(createHash('sha256').update(compilerBytes).digest('hex'),digest);
  return runVerifiedScalarStateSource({compilerBytes,compilerSha256:digest,compilerLength:compilerBytes.length,source});
};
test('three exact positive guest fixtures through real browser compiler',async()=>{
  for(const [p,expected,leases] of [
    ['state-short-intrinsics.atto','42\n2\n42\n0\n',null],
    ['state-owned-tuple-snapshot.atto','42\n1\n50\n2\n0\n0\n',5],
    ['state-write-expressions.atto','42\n43\nfalse\n43\n',3]
  ]){
    const result=await run(await readFile(path('pass/'+p),'utf8'));
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.stdout,expected);
    assert.equal(result.state.active,0);
    assert.equal(result.state.quiescent,true);
    const enter=result.events.filter(e=>e.kind==='enter');
    const leave=result.events.filter(e=>e.kind==='leave');
    assert.equal(enter.length,leave.length);
    if(leases!==null)assert.equal(enter.length,leases);
  }
});
test('seven exact negatives fail in compiler without guest execution',async()=>{
  for(const p of ['state-short-read-mutation.atto','state-short-nested-mixed-alias.atto','state-short-binder-escape.atto','state-short-override.atto','state-tuple-snapshot-wrong-binder.atto','state-tuple-snapshot-type-mismatch.atto','state-write-expression-missing.atto']){
    const result=await run(await readFile(path('fail/'+p),'utf8'));
    assert.equal(result.ok,false,p);assert.equal(result.phase,'compile',p);
    assert.ok(result.diagnostics.length,p);
    assert.equal('state' in result,false,p);
  }
});
test('checked integer overflow unwinds and retires the outstanding write ticket',async()=>{
  const source=`define state container Counter as
    state { let int count = 9223372036854775807; }
    pub increment(): int {
      return state_w(|s| -> { s.count = s.count + 1; return s.count; });
    }
  end
  pub fnc main(): int { val c = new Counter(); return c.increment(); }`;
  const r=await run(source);
  assert.equal(r.ok,false,JSON.stringify(r));assert.equal(r.phase,'guest');
  assert.equal(r.panic,1);assert.equal(r.state.active,0);assert.equal(r.state.quiescent,true);
  assert.equal(r.events.filter(x=>x.kind==='enter').length,1);
  assert.equal(r.events.filter(x=>x.kind==='abort').length,1);
  assert.equal(r.stdout,'');
});
