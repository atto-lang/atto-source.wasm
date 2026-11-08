/** Browser-only, trusted scalar actor gate. This is NOT untrusted tenant isolation. */
import {assertNoManagedWasm} from '../scripts/no-managed-wasm.mjs';
import {assertScalarActorAbi} from '../scripts/actor-scalar-abi.mjs';

export const ACTOR_MAX_BYTES = 1_048_576;
export const ACTOR_MEMORY_PAGES = 2;

export async function admitBrowserActor(input, approvedSha256) {
  if (!(input instanceof Uint8Array) || input.byteLength < 8 ||
      input.byteLength > ACTOR_MAX_BYTES ||
      !(input.buffer instanceof ArrayBuffer) ||
      (typeof SharedArrayBuffer !== 'undefined' && input.buffer instanceof SharedArrayBuffer))
    throw Error('browser actor requires bounded, private Uint8Array module bytes');
  if (typeof approvedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(approvedSha256))
    throw Error('browser actor requires independently approved lowercase SHA-256');
  const bytes = new Uint8Array(input.byteLength);
  bytes.set(input); // Own snapshot: hash and compile identical bytes.
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== approvedSha256) throw Error('browser actor artifact digest mismatch');
  if (![0,97,115,109,1,0,0,0].every((v,i) => bytes[i] === v))
    throw Error('invalid WebAssembly module header');
  let at = 8;
  const fail = why => {throw Error('browser actor admission: ' + why);};
  const u32 = end => {
    let value = 0;
    for (let i=0;i<5;i++) {
      if (at>=end) fail('truncated LEB');
      const octet = bytes[at++];
      if (i===4 && (octet&0xf0)) fail('invalid u32 LEB');
      value += (octet&0x7f) * 2**(7*i);
      if (!(octet&0x80)) return value;
    }
    fail('overlong LEB');
  };
  let memorySections=0;
  while (at<bytes.length) {
    const section=bytes[at++], len=u32(bytes.length), end=at+len;
    if (end>bytes.length || !Number.isSafeInteger(end)) fail('truncated section');
    if ([2,4,8,9,13].includes(section)) fail('imports/tables/start/elements/tags forbidden');
    if (section>12) fail('unrecognized extension section');
    if (section===5) {
      if (++memorySections!==1 || u32(end)!==1 || u32(end)!==1 ||
          u32(end)!==ACTOR_MEMORY_PAGES || u32(end)!==ACTOR_MEMORY_PAGES || at!==end)
        fail('actor requires one private fixed two-page wasm32 memory');
    }
    at=end;
  }
  if (memorySections!==1) fail('actor memory section missing');
  assertNoManagedWasm(bytes);
  assertScalarActorAbi(bytes);
  if (!WebAssembly.validate(bytes)) fail('invalid Wasm guest');
  const module = await WebAssembly.compile(bytes);
  if (WebAssembly.Module.imports(module).length!==0) fail('unexpected host imports');
  const actual = WebAssembly.Module.exports(module).map(x=>[x.name,x.kind]).sort();
  const expected = [
    ['memory','memory'],
    ['oreslang_wasm_actor_init','function'],
    ['oreslang_wasm_actor_on_message','function'],
    ['oreslang_wasm_actor_teardown','function']
  ].sort();
  if (JSON.stringify(actual)!==JSON.stringify(expected)) fail('actor exports mismatch');
  return module;
}
