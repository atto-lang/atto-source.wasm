import test from 'node:test';
import assert from 'node:assert/strict';
import { fixed_memory_pages, actor_names } from '../src/wasm-profile.mjs';

const scalar=Buffer.from('0061736d010000000105016000017e03020100070801046d61696e00000a06010400422a0b','hex');
function insert_before_exports(section) {
  // Core sections in the fixture: type(1), function(3), export(7), code(10).
  return Buffer.concat([scalar.subarray(0,19),Buffer.from(section),scalar.subarray(19)]);
}
function with_custom_actor_section(names) {
  const payload=[11,...Buffer.from('atto.actors'),names.length];
  for(const n of names)payload.push(n.length,...Buffer.from(n));
  return Buffer.concat([scalar,Buffer.from([0,payload.length,...payload])]);
}
test('admit scalar no-memory and bounded fixed memory, deny growth',()=>{
  assert.equal(fixed_memory_pages(scalar),0);
  const fixed=insert_before_exports([5,4,1,1,1,1]);
  assert.equal(WebAssembly.validate(fixed),true);
  assert.equal(fixed_memory_pages(fixed),1);
  const growable=insert_before_exports([5,3,1,0,1]);
  assert.equal(WebAssembly.validate(growable),true);
  assert.throws(()=>fixed_memory_pages(growable),/E_WASM_MEMORY/);
  const shared=insert_before_exports([5,4,1,3,1,1]);
  assert.throws(()=>fixed_memory_pages(shared),/E_WASM_MEMORY/);
  const large=insert_before_exports([5,4,1,1,17,17]);
  assert.throws(()=>fixed_memory_pages(large),/E_WASM_MEMORY/);
});
test('disallow Wasm tables and corrupted memory section',()=>{
  assert.throws(()=>fixed_memory_pages(insert_before_exports([4,4,1,0x70,0,1])),/E_WASM_TABLE/);
  assert.throws(()=>fixed_memory_pages(insert_before_exports([5,4,1,1,1])),/E_WASM_LAYOUT/);
  assert.throws(()=>fixed_memory_pages(Buffer.from('ff0061736d01000000','hex')),/E_WASM_HEADER/);
});
test('parse actor-name custom section and reject duplicate section',()=>{
  const good=with_custom_actor_section(['Counter']);
  assert.equal(WebAssembly.validate(good),true);
  const module=new WebAssembly.Module(good);
  assert.deepEqual(actor_names(module),['Counter']);
  assert.deepEqual(actor_names(new WebAssembly.Module(scalar)),[]);
  const duplicate=Buffer.concat([good,good.subarray(scalar.length)]);
  assert.throws(()=>actor_names(new WebAssembly.Module(duplicate)),/E_WASM_ACTORS/);
});
