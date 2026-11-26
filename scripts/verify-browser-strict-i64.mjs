// Real compiler-Wasm -> strict ABI -> actual guest. Requires exact reviewed
// source head/tree and digest from a compiler build receipt, not vendored bytes.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';
const [path,pin,head,tree]=process.argv.slice(2);
assert.ok(path&&/^[a-f0-9]{64}$/.test(pin)&&/^[a-f0-9]{40}$/.test(head)&&/^[a-f0-9]{40}$/.test(tree),'compiler build receipt required');
const bytes=await readFile(path);
assert.ok(bytes.length>8&&bytes.length<=16*1024*1024);
await verifyCompilerBytes(bytes,pin,bytes.length);
const module=new WebAssembly.Module(bytes);
assert.deepEqual(WebAssembly.Module.imports(module),[]);
assert.ok(WebAssembly.Module.exports(module).some(e=>e.name==='compile_strict_i64'&&e.kind==='function'),'strict ABI missing');
const compiler=await createCompiler(bytes);
const pre='define dimension Time; define unit Second: Time; type Bounded = int where self >= 1 and self <= 42; ';
const main=e=>'pub fnc main() -> int { return '+e+'; }';
const cases=[
 [main('40+2'),42n],
 [main('84/2'),42n],
 [main('42 as Bounded'),42n],
 ['fnc f(int x) -> int { if x != 0 { return 42/x; } return 0; } '+main('f(1)'),42n],
 ['fnc f(int x) -> int { if x != 0 && 42/x > 0 { return 1; } return 42; } '+main('f(0)'),42n],
 ['pub fnc main() -> int { let Bounded n = 1; while n < 42 { n = n+1; } return n; }',42n],
 [main('42/0'),'E_VERIFY_UNPROVEN'],
 [main('-9223372036854775808 / -1'),'E_VERIFY_UNPROVEN'],
 ['fnc f(int x) -> Bounded { return x as Bounded; } '+main('f(42)'),'E_VERIFY_UNPROVEN'],
 ['pub fnc main() -> int { let int x = 1; x = 0; return 42/x; }','E_VERIFY_UNPROVEN'],
 [main('40+2'),42n],
];
for(const [body,want] of cases){
 const source=pre+body;
 const result=compiler.compile(source,'wasm','strict');
 if(typeof want==='string'){
  assert.equal(result.ok,false,source);
  assert.equal(Object.hasOwn(result,'wasm'),false);
  assert.equal(Object.hasOwn(result,'esm'),false);
  assert.ok(result.diagnostics[0].message.includes(want+':'),JSON.stringify(result.diagnostics));
 }else{
  assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
  const guest=new WebAssembly.Module(result.wasm);
  assert.deepEqual(WebAssembly.Module.imports(guest),[]);
  const instance=new WebAssembly.Instance(guest,{});
  assert.equal(instance.exports.main(),want);
  assert.equal(instance.exports.panic_code.value,0);
 }
 console.log('PASS STRICT_BROWSER',createHash('sha256').update(source).digest('hex'));
}
const fallback=compiler.compile(main('42'),'wasm','strict');
assert.equal(fallback.ok,false);assert.ok(fallback.diagnostics[0].message.includes('E_VERIFY_UNSUPPORTED:'));
assert.equal(Object.hasOwn(fallback,'wasm'),false);
console.log('STRICT_BROWSER_VERIFIED',head,tree,pin,cases.length+1);
