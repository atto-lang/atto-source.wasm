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
  if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) throw new TypeError('E_WASM_INPUT');
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer,input.byteOffset,input.byteLength);
  if (bytes.length === 0 || bytes.length > MAX_WASM_BYTES) throw new Error('E_WASM_SIZE');
  const owned = Uint8Array.from(bytes);
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
  const has_init = exports.some(x=>x.name==='actor_init' && x.kind==='function');
  const has_receive = exports.some(x=>x.name==='actor_receive' && x.kind==='function');
  if (has_init !== has_receive) throw new Error('E_WASM_ACTOR_ABI');
  const actors=has_init && has_receive;
  const types=actor_names(module);
  if (actors !== (types.length>0)) throw new Error('E_WASM_ACTORS');
  if (pages>0 && !exports.some(x=>x.name==='memory' && x.kind==='memory')) throw new Error('E_WASM_MEMORY_EXPORT');
  if (actors && !pages) throw new Error('E_WASM_ACTOR_MEMORY');
  return {bytes:owned,module,imports:imports.map(x=>x.module+'.'+x.name),actors,actor_names:types,memory_pages:pages};
}
export async function package_browser_guest(input) {
  const admitted=admit_browser_guest(input);
  const hash=await crypto.subtle.digest('SHA-256',admitted.bytes);
  const sha256=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
  return {wasm:admitted.bytes,manifest:{schema:SCHEMA,protocol:PROTOCOL,guest_abi:'atto.browser.guest.v2',
    wasm_sha256:sha256,byte_length:admitted.bytes.length,has_actors:admitted.actors,actor_names:admitted.actor_names,memory_pages:admitted.memory_pages,imports:admitted.imports,
    tenant_execution:'dedicated-worker',actor_heap:'separate-wasm-instances',
    route_wire:'atto.browser.route.v1',route_payload:'i64-signed-le8'}};
}
