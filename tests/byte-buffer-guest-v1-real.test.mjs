import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {compileByteBufferGuestV1,ByteBufferGuestError} from '../src/byte-buffer-guest-v1.mjs';

// Byte-exact positive fixtures copied from atto-platform-conformance PR #104.
// The legacy import spelling is accepted ONLY by this bounded compiler profile.
// No canonical stdlib body is loaded, and typed runtime errors are NOT supported.
const positives = [
  ['01-u32-le-roundtrip','7d83aa7d8a6000875fb4c73a36493053170b9932'],
  ['02-u32-be-roundtrip','65f1ede56cf40f5c52ddec6e9e3a6b2772d91e88'],
  ['03-zero-initialized','eabe3baf65153baae72bdc65de99f05a9a114cab'],
  ['04-unaligned-le','805560434c628274d2cd2d73eb92bd64947c9dd5'],
  ['05-last-valid-offset','a6459f9129e8c9a6d4799342fafbd73b72ccf026'],
  ['13-u8-roundtrip','fcf06b5739fa54ad6301f46fe8c3aeab7399fb4b'],
  ['14-u16-le-roundtrip','2070a1fdb94104965e503df95491c1dfc73730cf'],
  ['15-u16-be-roundtrip','4da5e9a0915743d30b55922a3e50e4045a65af43'],
  ['16-cross-endian-value','ddf68a7d285309ea6aca4ccd241c439f02ba7fc3'],
  ['17-u32-max-value','512f5feddcbb199ded8c097b33f99b6850e07fee'],
  ['21-u8-last-offset','cc3656aa50b949c73d0ceece4f32fbb58eee8def'],
];
function guest(source) {
  const wasm=compileByteBufferGuestV1(source);
  assert.equal(WebAssembly.validate(wasm),true);
  const module=new WebAssembly.Module(wasm);
  assert.deepEqual(WebAssembly.Module.imports(module),[]);
  const instance=new WebAssembly.Instance(module,{});
  return {wasm,instance,returned:instance.exports.main(),bytes:new Uint8Array(instance.exports.memory.buffer)};
}
function source(name) {
  return readFileSync(new URL('./fixtures/byte-buffer-v1/'+name+'.atto',import.meta.url),'utf8');
}
function gitBlob(text) {
  const bytes=Buffer.from(text,'utf8');
  return createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex');
}
function rejects(text,code) {
  assert.throws(()=>compileByteBufferGuestV1(text),
    error=>error instanceof ByteBufferGuestError && error.code===code,code);
}

test('all 11 byte-exact shared positive fixtures compile and execute as guest Wasm',()=>{
  for(const [name,sha] of positives){
    const text=source(name);
    assert.equal(gitBlob(text),sha,'shared case '+name+' must not drift');
    const output=guest(text);
    assert.equal(output.returned,1n,'compiled guest failed: '+name);
    assert.equal(output.bytes.length,65536,'one fixed, non-growable 64-KiB memory');
    assert.throws(()=>output.instance.exports.memory.grow(1),RangeError);
    assert.deepEqual(compileByteBufferGuestV1(text),output.wasm,'deterministic emit');
  }
});

test('original BB-001 executes correct guest memory bytes, without any host import',()=>{
  const out=guest(source('01-u32-le-roundtrip'));
  assert.equal(out.returned,1n);
  assert.deepEqual(Array.from(out.bytes.slice(0,8)),[0x78,0x56,0x34,0x12,0,0,0,0]);
});

test('fail-closed invalid source never returns executable guest bytes',()=>{
  const original=source('01-u32-le-roundtrip');
  rejects(original.replace('val mut bytes','val bytes'),'E_IMMUTABLE');
  rejects(original.replace('write_u32_le(0,','write_u32_le(5,'),'E_BUFFER_BOUNDS');
  rejects(original.replace('write_u32_le(0,','write_u32_le(-1,'),'E_BUFFER_BOUNDS');
  rejects(original.replace('0x12345678);','4294967296);'),'E_BUFFER_VALUE');
  rejects(original.replace('allocate(8)','allocate(-1)'),'E_BUFFER_ALLOCATION');
  rejects(original.replace('allocate(8)','allocate(4097)'),'E_BUFFER_ALLOCATION');
  rejects(original.replace('std.buffer','std.fs'),'E_BUFFER_MODULE');
  rejects(original.replace('write_u32_le','write_u64_le'),'E_BUFFER_UNSUPPORTED');
  rejects(original.replace('read_u32_le(0)','read_u32_le(5)'),'E_BUFFER_BOUNDS');
  rejects(original.replace('  return header eq 0x12345678 ? 1 : 0;','  return process.exit(0);'),'E_BUFFER_UNKNOWN');
  rejects(original+'pub fnc exploit(): int { return 9; }','E_BUFFER_SYNTAX');
  rejects('x'.repeat(17000),'E_BUFFER_SOURCE_LIMIT');
});

test('256 varied real guest modules preserve unsigned values for u8/u16/u32 both endian forms',()=>{
  const head='import module buffer from pkg "std.buffer";\npub fnc main(): int throws Error {\n';
  const foot='}\n';
  let state=0x12345678;
  for(let i=0;i<256;i++){
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    const bits=[8,16,32][i%3];
    const max=bits===8?255:bits===16?65535:4294967295;
    const value=state%(max+1),offset=i%6,endian=i%2?'be':'le';
    const method='u'+bits+(bits===8?'':'_'+endian);
    const program=head+'  val mut b = buffer.ByteBuffer.allocate(12);\n'
      +'  b.write_'+method+'('+offset+', '+value+');\n'
      +'  return b.read_'+method+'('+offset+') eq '+value+' ? 1 : 0;\n'+foot;
    assert.equal(guest(program).returned,1n,'iteration '+i);
  }
});

test('separate WebAssembly instances never share writable byte storage',()=>{
  const module=new WebAssembly.Module(compileByteBufferGuestV1(source('01-u32-le-roundtrip')));
  const left=new WebAssembly.Instance(module,{}),right=new WebAssembly.Instance(module,{});
  assert.notEqual(left.exports.memory.buffer,right.exports.memory.buffer);
  left.exports.main();
  assert.deepEqual([...new Uint8Array(right.exports.memory.buffer).slice(0,8)],[0,0,0,0,0,0,0,0]);
  assert.equal(right.exports.main(),1n);
  new Uint8Array(left.exports.memory.buffer)[0]=99;
  assert.equal(new Uint8Array(right.exports.memory.buffer)[0],0x78);
});
