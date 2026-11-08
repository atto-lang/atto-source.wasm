/**
 * Fail-closed, opt-in compiler artifact gate. No network, no downloads,
 * and NO private compiler binary publication. The runner must independently
 * authenticate its pinned environment values and source tree.
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export const TWO_ATTO_ACTORS=[
  'define actor Worker as receive(msg: int) -> int { return msg + 1; } end',
  'pub fnc main(): int {',
  '  val first = spawn Worker();',
  '  val second = spawn Worker();',
  '  return 0;',
  '}',
].join('\n');

export async function compileApprovedAttoSource(source=TWO_ATTO_ACTORS,env=process.env) {
  const {
    ATTO_COMPILER_WASM:file,ATTO_COMPILER_SHA256:approved,
    ATTO_COMPILER_SOURCE_HEAD:head,ATTO_COMPILER_SOURCE_TREE:tree
  }=env;
  const hex40=s=>typeof s==='string'&&/^[0-9a-f]{40}$/.test(s);
  const hex64=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
  assert.ok(typeof file==='string'&&file.length>0&&hex64(approved)&&hex40(head)&&hex40(tree),
    'reviewed compiler path, digest, source HEAD and tree REQUIRED; no skip');
  const compilerBytes=await readFile(file);
  assert.ok(compilerBytes.length>0&&compilerBytes.length<=10*1024*1024,
    'bounded Rust compiler Wasm artifact required');
  const compilerSha256=createHash('sha256').update(compilerBytes).digest('hex');
  assert.equal(compilerSha256,approved,'compiler artifact digest must match independent pin');
  const module=await WebAssembly.compile(compilerBytes);
  assert.deepEqual(WebAssembly.Module.imports(module),[],'compiler cannot import host APIs');
  const compiler=await WebAssembly.instantiate(module,{});
  const api=compiler.exports;
  assert.equal(api.abi_version(),2,'compiler ABI v2 required');
  const sourceBytes=new TextEncoder().encode(source);
  assert.ok(sourceBytes.length>0&&sourceBytes.length<=api.input_capacity(),
    'source exceeds compiler input bounds');
  const memory=()=>new Uint8Array(api.memory.buffer);
  const ptr=api.input_ptr();
  assert.ok(Number.isSafeInteger(ptr)&&ptr+sourceBytes.length<=memory().length,
    'compiler input pointer outside guest linear memory');
  memory().set(sourceBytes,ptr);
  const result=api.compile(sourceBytes.length);
  if(result!==0){
    assert.equal(api.result_length(),0,'compiler must not return bytes after error');
    const b=memory(),at=api.error_ptr();
    assert.ok(Number.isSafeInteger(at)&&at>=0&&at<b.length,'compiler error pointer invalid');
    let end=at;
    while(end<b.length&&b[end]&&end-at<256)end++;
    assert.fail('real Rust Atto compiler rejected source: '+
      new TextDecoder().decode(b.subarray(at,end)));
  }
  const start=api.result_ptr(),n=api.result_length();
  assert.ok(Number.isSafeInteger(start)&&Number.isSafeInteger(n)&&n>0&&
    n<=1_048_576&&start+n<=memory().length,'compiler output exceeds bounds');
  const guest=Uint8Array.from(memory().subarray(start,start+n));
  assert.ok(WebAssembly.validate(guest),'Rust compiler emitted invalid guest Wasm');
  return {guest,sourceHead:head,sourceTree:tree,compilerSha256,
    guestSha256:createHash('sha256').update(guest).digest('hex')};
}
