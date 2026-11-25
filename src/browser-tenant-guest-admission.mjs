import { snapshotGuestBytes } from './snapshot-guest-bytes.mjs';
import { assertCoreI64Entry, coreFunctionSignature } from '../scripts/core-i64-abi.mjs';
import { fixed_memory_pages, actor_names, MAX_WASM_BYTES as MAX_BYTES } from './wasm-profile.mjs';

// Validate a Rust-compiler-produced browser guest before giving it to the
// per-tenant Wasm loader in atto-browser. Admission isn't a sandbox proof.
export const SCHEMA = 'atto.browser.wasm-guest.v1';
export const PROTOCOL = 'atto.browser.tenants.v1';
export const MAX_WASM_BYTES = MAX_BYTES;
export const ALLOWED_ATTO_IMPORTS = Object.freeze([
  'print_i64','print_bool','print_str','print_newline','print_f64','actor_spawn','actor_send'
]);
export function admit_browser_guest(input) {
  // Snapshot with native buffer slots: no user getters, proxies, or shared
  // backing can change the bytes between validation, hashing and execution.
  let owned;
  try { owned=snapshotGuestBytes(input,MAX_WASM_BYTES); }
  catch(error) {
    if(error?.message==='Wasm module exceeds maximum byte size') throw new Error('E_WASM_SIZE');
    throw new TypeError('E_WASM_INPUT');
  }
  if(owned.length===0) throw new Error('E_WASM_SIZE');
  if (!WebAssembly.validate(owned)) throw new Error('E_WASM_INVALID');
  const pages = fixed_memory_pages(owned);
  const module = new WebAssembly.Module(owned);
  const imports = WebAssembly.Module.imports(module);
  for (const item of imports) {
    if (item.module !== 'atto' || item.kind !== 'function' || !ALLOWED_ATTO_IMPORTS.includes(item.name)) {
      throw new Error('E_WASM_IMPORT: '+item.module+'.'+item.name);
    }
  }
  const exports = WebAssembly.Module.exports(module);
  const entry = exports.find(x=>x.name==='main');
  if (entry?.kind !== 'function') throw new Error('E_WASM_MAIN');
  // Exported .length checks params, not return type. Enforce i64 statically.
  try { assertCoreI64Entry(owned,'main'); }
  catch { throw new Error('E_WASM_MAIN_SIGNATURE'); }
  const has_init = exports.some(x=>x.name==='actor_init' && x.kind==='function');
  const has_receive = exports.some(x=>x.name==='actor_receive' && x.kind==='function');
  if (has_init !== has_receive) throw new Error('E_WASM_ACTOR_ABI');
  const actors=has_init && has_receive;
  const types=actor_names(module);
  if (actors !== (types.length>0)) throw new Error('E_WASM_ACTORS');
  if (pages>0 && !exports.some(x=>x.name==='memory' && x.kind==='memory')) throw new Error('E_WASM_MEMORY_EXPORT');
  if (actors && !pages) throw new Error('E_WASM_ACTOR_MEMORY');
  if (actors) {
    // Exported Wasm function.length checks count, not i32/i64 parameter types
    // or the void result contract. Confirm exact actor ABI before instantiation.
    const init=coreFunctionSignature(owned,'actor_init');
    const receive=coreFunctionSignature(owned,'actor_receive');
    const signature=(s,params)=>!!s && s.results.length===0 &&
      s.params.length===params.length &&
      params.every((type,i)=>s.params[i]===type);
    if(!signature(init,[0x7f]) || !signature(receive,[0x7f,0x7e,0x7e]))
      throw new Error('E_WASM_ACTOR_SIGNATURE');
  }
  // The v1 profile rejects start sections and non-function imports, so
  // instantiating with inert host functions cannot execute guest code.
  // Export names/kinds alone do not prove the callable browser ABI.
  const host=Object.fromEntries(imports.map(x=>[x.name,()=>0]));
  const instance=new WebAssembly.Instance(module,{atto:host});
  if (instance.exports.main.length!==0)throw new Error('E_WASM_MAIN_SIGNATURE');
  if (actors && (instance.exports.actor_init.length!==1 ||
                 instance.exports.actor_receive.length!==3))
    throw new Error('E_WASM_ACTOR_SIGNATURE');
  return {bytes:owned,module,imports:imports.map(x=>x.module+'.'+x.name),actors,actor_names:types,memory_pages:pages};
}
export async function package_browser_guest(input) {
  const admitted=admit_browser_guest(input);
  const hash=await crypto.subtle.digest('SHA-256',admitted.bytes);
  const sha256=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
  return {wasm:admitted.bytes,manifest:{schema:SCHEMA,protocol:PROTOCOL,guest_abi:'atto.browser.guest.v2',
    wasm_sha256:sha256,byte_length:admitted.bytes.length,has_actors:admitted.actors,actor_names:admitted.actor_names,memory_pages:admitted.memory_pages,imports:admitted.imports,
    tenant_execution:'dedicated-worker',actor_heap:'separate-wasm-instances',
    route_wire:'atto.browser.route.v1',route_payload:'i64-signed-le8',
    send_receipt_protocol:'atto.browser.send-receipt.v1',
    send_receipt_outcomes:['processed','rejected','unknown']}};
}
