import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';
const [path,pin,head,tree]=process.argv.slice(2);
if(!path||! /^[a-f0-9]{64}$/.test(pin??'')||! /^[a-f0-9]{40}$/.test(head??'')||! /^[a-f0-9]{40}$/.test(tree??''))
 throw Error('usage: node scripts/verify-browser-refinement-casts.mjs compiler.wasm sha256 sourceHead sourceTree');
const bytes=await readFile(path);
assert.ok(bytes.length>8&&bytes.length<=16*1024*1024);
await verifyCompilerBytes(bytes,pin,bytes.length);
const module=new WebAssembly.Module(bytes);
assert.deepEqual(WebAssembly.Module.imports(module),[]);
const compiler=await createCompiler(bytes);
const pre='define dimension Time; define unit Second: Time; define unit Millis: Time = Second / 1000; type Positive = int where self > 0 and units in Second; type Bounded = int where self >= 1 and self <= 42;';
const main=e=>'pub fnc main() -> int { return '+e+'; }';
const cases=[];
for(const [id,cast] of [['prefix',(x,t)=>'<'+t+'>('+x+')'],['postfix',(x,t)=>'('+x+')::<'+t+'>'],['keyword',(x,t)=>'('+x+' as '+t+')']]){
 cases.push([id+'-value',main(cast('42.<Second>','Positive')+' / 1<Second>'),42n],
 [id+'-violation',main(cast('0.<Second>','Positive')+' / 1<Second>'),7],
 [id+'-prior-trap',main(cast('1<Second> / 0<Second>','Bounded')),2],
 [id+'-wrong-scale',main(cast('42<Millis>','Positive')),'E_UNIT_SCALE'],
 [id+'-erasure',main(cast('42<Second>','i64')),'E_UNIT_ERASURE']);
}
cases.push(['inferred','pub fnc main() -> int { val a = 42.<Second>::<Positive>; return a / 1<Second>; }',42n],
 ['inferred-violation','pub fnc main() -> int { val a = 0.<Second>::<Positive>; return a / 1<Second>; }',7],
 ['inferred-erasure','pub fnc main() -> int { val a = 42.<Second>; return a; }','E_UNIT_ERASURE'],
 ['checked-helper','fnc f(int n) -> Bounded { return n::<Bounded>; } '+main('f(42)'),42n],
 ['checked-helper-invalid','fnc f(int n) -> Bounded { return n::<Bounded>; } '+main('f(43)'),7],
 ['unproved-arg','fnc f(Bounded n) -> int { return n; } '+main('f(43)'),'E_REFINEMENT_PRECONDITION'],
 ['retag',main('42.<Second>.<Second>'),'E_UNIT_ATTACHMENT'],
 ['overflow',main('(9223372036854775807 + 1) as Bounded'),1]);
const sha=x=>createHash('sha256').update(x).digest('hex');
for(const [id,body,want] of cases){
 const source=pre+'\n'+body;
 const result=compiler.compile(source);
 if(typeof want==='string'){
  assert.equal(result.ok,false,id);
  assert.equal(Object.hasOwn(result,'wasm'),false,id);
  assert.equal(Object.hasOwn(result,'esm'),false,id);
  assert.equal(result.diagnostics.length,1,id);
  assert.match(result.diagnostics[0].message,new RegExp(want+':'),id);
 }else{
  assert.equal(result.ok,true,id+': '+JSON.stringify(result.diagnostics));
  const guest=new WebAssembly.Module(result.wasm);
  assert.deepEqual(WebAssembly.Module.imports(guest),[],id);
  assert.deepEqual(WebAssembly.Module.exports(guest).map(x=>x.name).sort(),['main','panic_code'],id);
  const instance=new WebAssembly.Instance(guest,{});
  assert.equal(instance.exports.panic_code.value,0,id);
  if(typeof want==='bigint'){
   assert.equal(instance.exports.main(),want,id);
   assert.equal(instance.exports.panic_code.value,0,id);
  }else{
   assert.throws(()=>instance.exports.main(),WebAssembly.RuntimeError,id);
   assert.equal(instance.exports.panic_code.value,want,id);
  }
  console.log('GUEST_SHA256 '+id+' '+sha(result.wasm));
 }
 console.log('PASS browser-abi '+id+' '+sha(source));
}
// A failure must not poison subsequent valid compilation, nor mutate the
// caller's previous copied output, nor retain previous result bytes.
const first=compiler.compile(pre+'\n'+main('42'));
assert.equal(first.ok,true);
const saved=sha(first.wasm);
assert.equal(compiler.compile(pre+'\n'+main('missing')).ok,false);
const again=compiler.compile(pre+'\n'+main('43'));
assert.equal(again.ok,true);
assert.equal(sha(first.wasm),saved);
assert.equal(new WebAssembly.Instance(new WebAssembly.Module(again.wasm),{}).exports.main(),43n);
console.log('BROWSER_COMPILER '+head+' '+tree+' '+pin);
console.log('BROWSER_REFINEMENT_VERIFIED '+cases.length+' source cases plus reuse control');
