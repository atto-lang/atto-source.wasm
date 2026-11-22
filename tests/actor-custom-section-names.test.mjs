import test from 'node:test';
import assert from 'node:assert/strict';
import {actor_names} from '../src/wasm-profile.mjs';
const scalar=Buffer.from('0061736d010000000105016000017e03020100070801046d61696e00000a06010400422a0b','hex');
function moduleWithName(name){
  const value=Buffer.from(name,'utf8');
  const payload=Buffer.from([11,...Buffer.from('atto.actors'),1,value.length,...value]);
  if(payload.length>=128)throw Error('fixture over budget');
  const bytes=Buffer.concat([scalar,Buffer.from([0,payload.length]),payload]);
  assert.equal(WebAssembly.validate(bytes),true,'custom metadata does not change actual Wasm validity');
  return new WebAssembly.Module(bytes);
}
test('normal actor type metadata remains admitted',()=>{
  assert.deepEqual(actor_names(moduleWithName('Counter')),['Counter']);
  assert.deepEqual(actor_names(moduleWithName('Módulo.Row')),['Módulo.Row']);
});
test('reject untrusted actor names with NUL, control, formatting or padding',()=>{
  for(const name of ['Bad\0Name','A\nB','A\u202eB','A\u200bB',' Bad','Bad ','\ufeffBad','\u2028']){
    assert.throws(()=>actor_names(moduleWithName(name)),/E_WASM_ACTORS/,JSON.stringify(name));
  }
});
