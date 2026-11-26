// Requires an actual wasm32 compiler built from the Unicode Rust candidate.
// Existing vendored bytes are not silently substituted for the requested head.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';

test('Unicode browser compiler executes real guests and rejects malformed input',async t=>{
 const path=process.env.ATTO_UNICODE_COMPILER_WASM;
 const pin=process.env.ATTO_UNICODE_COMPILER_SHA256;
 const native=process.env.ATTO_UNICODE_NATIVE_COMPILER;
 if(!path&&!pin&&!native&&process.env.ATTO_REQUIRE_UNICODE_COMPILER!=='1'){
   t.skip('No exact-source Unicode compiler supplied; zero new guest evidence');return;
 }
 assert.ok(path&&pin&&native,'required compiler identity and native comparator missing');
 assert.match(pin,/^[a-f0-9]{64}$/);
 const bytes=await readFile(path);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),pin);
 await verifyCompilerBytes(bytes,pin,bytes.length);
 assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)),[]);
 const compiler=await createCompiler(bytes);
 const source='pub fnc main(): int { val Φ = 10; val φ = 20; val 数量 = 30; val 𠮷 = 40; if ¬false && ¬¬true then return Φ + φ + 数量 + 𠮷; else return 0; fi }';
 const result=compiler.compile(source);
 assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
 const module=new WebAssembly.Module(result.wasm);
 const imports=Object.create(null);
 for(const {module:m,name,kind} of WebAssembly.Module.imports(module)){
   assert.equal(kind,'function');
   (imports[m]??=Object.create(null))[name]=()=>{throw Error('unexpected host call '+m+'.'+name)};
 }
 assert.equal(new WebAssembly.Instance(module,imports).exports.main(),100n);
 const ascii=compiler.compile(source.replaceAll('¬','!'));
 assert.equal(ascii.ok,true,JSON.stringify(ascii.diagnostics));
 assert.deepEqual(result.wasm,ascii.wasm);
 const dir=await mkdtemp(join(tmpdir(),'atto-unicode-real-'));
 try {
   const src=join(dir,'guest.atto'),out=join(dir,'guest.wasm');
   await writeFile(src,source);
   const r=spawnSync(native,[src,'-o',out],{encoding:'utf8',timeout:30000});
   assert.equal(r.error,undefined);assert.equal(r.signal,null);
   assert.equal(r.status,0,r.stderr);
   assert.deepEqual(Buffer.from(result.wasm),await readFile(out));
 } finally {await rm(dir,{recursive:true,force:true});}
 for(const invalid of [
   'pub fnc main(): int { return 未定義; }',
   'pub fnc main(): bool { return ¬1; }',
   'pub fnc main(): int { return 42; } // \u202e',
   'pub fnc main(): int { return 42; } // \ud800'
 ]){
   const r=compiler.compile(invalid);
   assert.equal(r.ok,false);assert.equal('wasm' in r,false);
   assert.equal('esm' in r,false);assert.ok(r.diagnostics.length);
 }
 console.log('UNICODE_WASM_COMPILER_REAL_GUEST_RESULT=100; NATIVE_BYTE_PARITY_PASS');
});
