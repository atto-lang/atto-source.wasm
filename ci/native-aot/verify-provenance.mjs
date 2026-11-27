// Native AOT development provenance: exact checkout content, not release approval.
// Both historic seed and currently maintained native Rust blobs are recorded.
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, realpathSync} from 'node:fs';
import {resolve, sep} from 'node:path';

const REQUIRED=Object.freeze([
  'aot-host/profile.rs',
  'aot-host/io.rs',
  'aot-host/precompile/Cargo.lock',
  'aot-host/precompile/Cargo.toml',
  'aot-host/precompile/src/main.rs',
  'aot-host/precompile/src/publish.rs',
  'aot-host/precompile/src/wasm_admission.rs',
  'aot-host/run/Cargo.lock',
  'aot-host/run/Cargo.toml',
  'aot-host/run/build.rs',
  'aot-host/run/src/main.rs',
  'aot-host/run/src/tenant_isolation.rs',
]);
const SHA1=/^[0-9a-f]{40}$/;
function fail(message){throw new Error('E_NATIVE_AOT_PROVENANCE: '+message)}
function keysMatch(obj){
  return obj!==null && typeof obj==='object' && !Array.isArray(obj) &&
    Reflect.ownKeys(obj).length===REQUIRED.length &&
    REQUIRED.every(path=>Object.hasOwn(obj,path) && SHA1.test(obj[path]));
}
export function gitBlobSha(bytes){
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}
export function verifyNativeAotProvenance(root, manifest){
  if(!manifest || manifest.schema!=='atto.source-wasm-seeded-native-aot-prototype.v1' ||
     !SHA1.test(manifest?.origin?.commit) ||
     !SHA1.test(manifest?.current_snapshot?.base_commit) ||
     !keysMatch(manifest.source_blobs) || !keysMatch(manifest.current_source_blobs))
    fail('invalid manifest schema, origin, or SHA inventory');
  const physicalRoot=realpathSync(root);
  let migrated=0;
  for(const relative of REQUIRED){
    const path=resolve(physicalRoot,relative);
    if(!path.startsWith(physicalRoot+sep))fail('source escaped trusted root');
    // Every component must remain physical: a symlink could quietly replace
    // pinned Rust code with an outside file after checkout.
    let component=physicalRoot;
    for(const segment of relative.split('/')){
      component=resolve(component,segment);
      if(lstatSync(component).isSymbolicLink())fail('symlink native source: '+relative);
    }
    if(!lstatSync(path).isFile())fail('non-file native source: '+relative);
    const actual=gitBlobSha(readFileSync(path));
    if(actual!==manifest.current_source_blobs[relative])
      fail('current source mismatch: '+relative);
    if(actual!==manifest.source_blobs[relative])migrated++;
  }
  return Object.freeze({current_blobs_verified:REQUIRED.length,historic_seed_replacements:migrated,
    origin_head:manifest.origin.commit,reconciliation_parent:manifest.current_snapshot.base_commit});
}
if(process.argv[1] && import.meta.url===new URL('file://'+resolve(process.argv[1])).href){
  const root=resolve(process.argv[2] || '.');
  const manifest=JSON.parse(readFileSync(resolve(root,'ci/native-aot/source-provenance.json'),'utf8'));
  const report=verifyNativeAotProvenance(root,manifest);
  console.log('NATIVE_AOT_CURRENT_BLOBS_VERIFIED='+report.current_blobs_verified);
  console.log('NATIVE_AOT_HISTORIC_SEED_REPLACEMENTS='+report.historic_seed_replacements);
  console.log('NATIVE_AOT_ORIGIN_HEAD='+report.origin_head);
  console.log('NATIVE_AOT_RECONCILIATION_PARENT='+report.reconciliation_parent);
  console.log('SCOPE=NATIVE_AOT_SOURCE_INTEGRITY_ONLY_NOT_NATIVE_GUEST_EXECUTION');
}
