import test from 'node:test';
import assert from 'node:assert/strict';
import {admitCoreGuest} from '../src/guest-admission.mjs';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
import {readVisibilityProfile} from '../src/visibility-profile.mjs';

const base=[0,97,115,109,1,0,0,0,1,5,1,96,0,1,126,3,2,1,0,5,4,1,1,1,2,7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0,10,6,1,4,0,66,42,11];
function leb(n){const out=[];do{let b=n&127;n>>>=7;out.push(b|(n?128:0));}while(n);return out;}
function section(payload){
  const name=[...new TextEncoder().encode('atto.visibility.profile.v1')];
  const bytes=[...leb(name.length),...name,...payload];
  return [0,...leb(bytes.length),...bytes];
}
const entry=(name,scope,kind)=>[...leb(name.length),...new TextEncoder().encode(name),scope,kind];
const guest=(...sections)=>Uint8Array.from([...base,...sections.flat()]);
test('actual Rust wire order and module kind remain distinct from legacy manifest',()=>{
  const bytes=guest(section([2,...entry('main',1,2),...entry('Math',2,3)]));
  assert.deepEqual(readVisibilityProfile(new WebAssembly.Module(bytes)),[
    {name:'main',kind:'fnc',visibility:'public'},{name:'Math',kind:'module',visibility:'package'}]);
});
test('entry metadata only narrows otherwise valid scalar Wasm host ABI',async()=>{
  const bytes=guest(section([1,...entry('main',1,2)]));
  assert.equal((await runIsolatedCoreGuest(bytes)).value,42n);
  for(const [scope,kind] of [[2,2],[1,1],[1,3]]){
    const denied=guest(section([1,...entry('main',scope,kind)]));
    assert.equal(WebAssembly.validate(denied),true);
    assert.throws(()=>admitCoreGuest(denied),/EXPORT_PROFILE_ENTRY_DENIED/);
    await assert.rejects(runIsolatedCoreGuest(denied),/EXPORT_PROFILE_ENTRY_DENIED/);
  }
});
test('malformed metadata fails closed, including duplicate section and entry',()=>{
  const valid=section([1,...entry('main',1,2)]);
  for(const bytes of [
    guest(valid,valid),guest(section([2,...entry('main',1,2),...entry('main',2,2)])),
    guest(section([1,...entry('main',3,2)])),guest(section([1,...entry('main',1,4)])),
    guest(section([129,0,...entry('main',1,2)])),guest(section([1,4,109,97])),
    guest(section([1,...entry('main',1,2),0]))
  ]){
    assert.equal(WebAssembly.validate(bytes),true);
    assert.throws(()=>admitCoreGuest(bytes),/EXPORT_MANIFEST_/);
  }
});
test('absence of metadata never bypasses independent core ABI checks',()=>{
  assert.equal(admitCoreGuest(guest()).entry,'main');
  assert.throws(()=>admitCoreGuest(guest(section([1,...entry('helper',1,2)])),{entry:'helper'}));
});
