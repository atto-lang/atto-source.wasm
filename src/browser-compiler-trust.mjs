// Trust boundary for browser compiler releases. This is a verifier, not a
// compiler or a substitute for an independently authenticated source pin.
import { createHash, timingSafeEqual } from 'node:crypto';
import { snapshotGuestBytes } from './snapshot-guest-bytes.mjs';
import { snapshotCompilerTrustRecord } from './compiler-trust-record.mjs';

const FIELDS = ['abi','compiler_bytes','compiler_sha256','exports','import_count','schema','source_head','source_tree','target'];
const REQUIRED = {
  memory: 'memory', input_ptr: 'function', input_capacity: 'function',
  compile: 'function', result_ptr: 'function', result_length: 'function',
  error_ptr: 'function', error_line_number: 'function',
  error_column_number: 'function'
};
const EXPECTED_SCHEMA = 'atto.browser.compiler.artifact.v1';
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_ARTIFACT = 8 * 1024 * 1024;
const PAGE_BYTES = 65536;
const MAX_MEMORY_PAGES = 1024;

function fail(message) { throw new Error("E_TRUST: " + message); }
function equalDigest(left, right) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function readUleb(bytes, start) {
  let value = 0, shift = 0, i = start;
  for (let n=0;n<5;n++) {
    if (i >= bytes.length) fail('truncated unsigned LEB');
    const b = bytes[i++];
    if (n === 4 && (b & 0xf0)) fail('oversized unsigned LEB');
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return [value,i];
    shift += 7;
  }
  fail('unsigned LEB exceeds wasm32');
}
function inspectSections(bytes) {
  if (bytes.length < 8 || !Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([0,97,115,109,1,0,0,0]))) fail('not core Wasm v1');
  let i=8, memory=null;
  while(i<bytes.length) {
    const id=bytes[i++];
    const [length,next]=readUleb(bytes,i);
    i=next;const end=i+length;
    if (end>bytes.length) fail('section exceeds artifact');
    if (id===8) fail('start sections forbidden on browser compiler');
    if (id===5) {
      if(memory!==null) fail('duplicate memory sections');
      let [count,p]=readUleb(bytes,i);
      if(count!==1) fail('compiler must define exactly one memory');
      let flags;[flags,p]=readUleb(bytes,p);
      if(flags!==1) fail('compiler memory requires an explicit wasm32 maximum');
      let minimum,maximum;[minimum,p]=readUleb(bytes,p);[maximum,p]=readUleb(bytes,p);
      if(p!==end || minimum>maximum || maximum>MAX_MEMORY_PAGES) fail('compiler memory limit exceeds 64 MiB');
      memory={minimum,maximum};
    }
    i=end;
  }
  if(memory===null) fail('compiler must declare bounded linear memory');
  return memory;
}
/**
 * Only externally pinned values count as trust. A receipt shipped next to the
 * binary cannot authenticate itself; caller must obtain pins independently.
 */
export function verifyCompilerArtifact(request) {
  const envelope=snapshotCompilerTrustRecord(request,['wasm','receipt','trust'],'invalid request fields');
  const {wasm}=envelope;
  const receipt=snapshotCompilerTrustRecord(envelope.receipt,FIELDS,'missing/unrecognized receipt fields');
  const trust=snapshotCompilerTrustRecord(envelope.trust,
    ['source_head','source_tree','compiler_sha256'],'three independent trust pins required');
  // One immutable native-slot snapshot is used for every subsequent check.
  // Reject proxy/SharedArrayBuffer backing before reading caller properties.
  let bytes;
  try { bytes=snapshotGuestBytes(wasm,MAX_ARTIFACT); }
  catch { fail('invalid artifact length or backing'); }
  if(bytes.length===0) fail('invalid artifact length');
  if (!SHA1.test(trust.source_head) || !SHA1.test(trust.source_tree) || !SHA256.test(trust.compiler_sha256)) fail('invalid trust pins');
  if (!SHA1.test(receipt.source_head) || !SHA1.test(receipt.source_tree)
      || !SHA256.test(receipt.compiler_sha256)) fail('malformed receipt identity');
  if (receipt.schema!==EXPECTED_SCHEMA || receipt.abi!=='atto-playground-m0' ||
      receipt.target!=='wasm32-unknown-unknown' || receipt.import_count!==0) fail('unsupported compiler contract');
  if (receipt.source_head!==trust.source_head || receipt.source_tree!==trust.source_tree) fail('source identity mismatch');
  if (!equalDigest(receipt.compiler_sha256, trust.compiler_sha256)) fail('compiler digest not pinned');
  if (receipt.compiler_bytes!==bytes.length) fail('artifact length mismatch');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!equalDigest(digest,trust.compiler_sha256)) fail('artifact digest mismatch');
  const memory=inspectSections(bytes);
  if (!WebAssembly.validate(bytes)) fail('invalid WebAssembly binary');
  const module=new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length!==0) fail('host imports forbidden');
  const exports=WebAssembly.Module.exports(module);
  const map=new Map(exports.map(x=>[x.name,x.kind]));
  for(const [name,kind] of Object.entries(REQUIRED)) if(map.get(name)!==kind) fail('compiler export mismatch: '+name);
  if (!Array.isArray(receipt.exports) || receipt.exports.some(x=>typeof x!=='string') ||
      receipt.exports.length!==exports.length ||
      receipt.exports.some((x,i)=>x!==exports[i].name)) fail('receipt export mismatch');
  return Object.freeze({module, compiler_sha256:digest, memory, source_head:trust.source_head, source_tree:trust.source_tree});
}
/**
 * Executes the admitted compiler with a genuinely different source-derived
 * positive program and a negative program. Only call after verifyCompilerArtifact.
 */
export async function smokeCompilerAndGuest(admitted) {
  const instance=new WebAssembly.Instance(admitted.module,{});
  const api=instance.exports;
  const capacity=api.input_capacity();
  if (!Number.isInteger(capacity) || capacity<1 || capacity>4096) fail('unsafe input capacity');
  const pointer=api.input_ptr();
  if (!Number.isInteger(pointer) || pointer<0 || pointer+capacity>api.memory.buffer.byteLength) fail('unsafe input memory');
  const encode=new TextEncoder();
  const decoder=new TextDecoder();
  const compile=(source)=>{
    const bytes=encode.encode(source);
    if(bytes.length>capacity) fail('smoke input too large');
    new Uint8Array(api.memory.buffer,pointer,bytes.length).set(bytes);
    const result=api.compile(bytes.length);
    if (result!==0) {
      if (api.result_length()!==0) fail('rejected compile published artifact');
      const errorAddress=api.error_ptr(),mem=new Uint8Array(api.memory.buffer);
      if(!Number.isInteger(errorAddress) || errorAddress<0 || errorAddress>=mem.length) fail('invalid error pointer');
      let end=errorAddress;
      while(end<mem.length && mem[end] && end-errorAddress<256) end++;
      return {ok:false,error:decoder.decode(mem.subarray(errorAddress,end))};
    }
    const size=api.result_length(),address=api.result_ptr();
    if(!Number.isInteger(size)||size<8||size>65536||!Number.isInteger(address)||address<0||address+size>api.memory.buffer.byteLength)fail('invalid guest bytes');
    const guest=new Uint8Array(api.memory.buffer,address,size).slice();
    if(!WebAssembly.validate(guest))fail('invalid generated Wasm');
    const mod=new WebAssembly.Module(guest);
    if(WebAssembly.Module.imports(mod).length!==0)fail('guest imports forbidden');
    const exports=WebAssembly.Module.exports(mod);
    if(exports.length!==1||exports[0].name!=='main'||exports[0].kind!=='function')fail('guest ABI mismatch');
    const value=new WebAssembly.Instance(mod,{}).exports.main();
    if(!Number.isInteger(value))fail('guest return ABI mismatch');
    return {ok:true,value,guest};
  };
  const first=compile('fnc main() -> int { return 6 * 7; }');
  const second=compile('fnc main() -> int { return 6 * 8; }');
  if(!first.ok||first.value!==42||!second.ok||second.value!==48||
    Buffer.from(first.guest).equals(Buffer.from(second.guest)))fail('source-dependent execution was not demonstrated');
  const bad=compile('fnc main() -> int { int x=7; x=8; return x; }');
  if(bad.ok||!bad.error.includes('E_IMMUTABLE'))fail('immutable assignment not rejected');
  return {verified:true,guest_values:[first.value,second.value],negative:'E_IMMUTABLE'};
}
