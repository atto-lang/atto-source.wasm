import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';
const fail=(id,detail)=>{throw Error((id??'assertion')+': '+detail);};
const assert={
 ok(v,id){if(!v)fail(id,'expected truthy');},
 equal(a,b,id){if(a!==b)fail(id,'values differ: '+String(a)+' != '+String(b));},
 deepEqual(a,b,id){if(JSON.stringify(a)!==JSON.stringify(b))fail(id,'arrays differ');},
 match(a,b,id){if(!b.test(a))fail(id,'unexpected diagnostic: '+a);},
 throws(fn,type,id){try{fn();}catch(e){if(e instanceof type)return;fail(id,'wrong exception: '+e);}fail(id,'expected exception');}
};
const sha=async x=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',typeof x==='string'?new TextEncoder().encode(x):x)),b=>b.toString(16).padStart(2,'0')).join('');
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

export async function runRefinementCases(bytes,pin,head,tree,log=console.log,typedCases=null){
 if(!/^[a-f0-9]{64}$/.test(pin??'')||! /^[a-f0-9]{40}$/.test(head??'')||! /^[a-f0-9]{40}$/.test(tree??'')) throw Error('invalid compiler receipt');
 assert.ok(bytes.length>8&&bytes.length<=16*1024*1024);
 await verifyCompilerBytes(bytes,pin,bytes.length);
 const module=new WebAssembly.Module(bytes);
 assert.deepEqual(WebAssembly.Module.imports(module),[]);
 const compiler=await createCompiler(bytes);
 const codes={integerOverflow:1,divisionByZero:2,refinementViolation:7};
 const records=typedCases===null?cases.map(([id,body,want])=>[id,pre+'\n'+body,want]):typedCases.map(({source,text,expected,verification='ordinary'})=>{
   assert.ok(['ordinary','strict'].includes(verification),source);
   assert.match(source,/^generated-binding-[a-z-]+\.atto$/);
   assert.ok(typeof text==="string");
   if(expected.kind==="diagnostic")return [source,text,expected.category,verification];
   if(expected.kind==="value")return [source,text,BigInt(expected.decimal),verification];
   assert.ok(["arithmeticFailure","refinementFailure"].includes(expected.kind)&&Object.hasOwn(codes,expected.category),source);
   return [source,text,codes[expected.category],verification];
 });
 if(typedCases!==null)assert.equal(records.length,24);
 assert.equal(new Set(records.map(x=>x[0])).size,records.length);
 for(const [id,source,want,verification='ordinary'] of records){
 const result=compiler.compile(source,'wasm',verification);
 if(typeof want==='string'||want===null){
  assert.equal(result.ok,false,id);
  assert.equal(Object.hasOwn(result,'wasm'),false,id);
  assert.equal(Object.hasOwn(result,'esm'),false,id);
  assert.equal(result.diagnostics.length,1,id);
  if(want===null)assert.ok(result.diagnostics[0].message.length>0,id);else assert.match(result.diagnostics[0].message,new RegExp(want+':'),id);
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
  log('GUEST_SHA256 '+id+' '+await sha(result.wasm));
 }
 log('PASS browser-abi '+id+' '+await sha(source));
}
// A failure must not poison subsequent valid compilation, nor mutate the
// caller's previous copied output, nor retain previous result bytes.
// Keep the original default quantity-language controls. Typed corpora
// must also prove reuse using their own admitted source profile.
const initial=typedCases===null?['reuse-42',pre+'\n'+main('42'),42n]:
  records.find(record=>typeof record[2]==='bigint');
const rejected=typedCases===null?['reuse-missing',pre+'\n'+main('missing'),null]:
  records.find(record=>typeof record[2]==='string'||record[2]===null);
const subsequent=typedCases===null?['reuse-43',pre+'\n'+main('43'),43n]:
  records.find(record=>typeof record[2]==='bigint'&&record[2]!==initial?.[2]);
assert.ok(initial&&rejected&&subsequent,'reuse requires two distinct values and a diagnostic');
const first=compiler.compile(initial[1],'wasm',initial[3]??'ordinary');
assert.equal(first.ok,true,initial[0]+' reuse initial');
const saved=await sha(first.wasm);
assert.equal(new WebAssembly.Instance(new WebAssembly.Module(first.wasm),{}).exports.main(),initial[2],initial[0]);
const bad=compiler.compile(rejected[1],'wasm',rejected[3]??'ordinary');
assert.equal(bad.ok,false,rejected[0]+' reuse failure');
assert.equal(Object.hasOwn(bad,'wasm'),false,rejected[0]);
assert.equal(Object.hasOwn(bad,'esm'),false,rejected[0]);
assert.equal(bad.diagnostics.length,1,rejected[0]);
if(rejected[2]!==null)assert.match(bad.diagnostics[0].message,new RegExp(rejected[2]+':'),rejected[0]);
const again=compiler.compile(subsequent[1],'wasm',subsequent[3]??'ordinary');
assert.equal(again.ok,true,subsequent[0]+' reuse subsequent');
assert.equal(await sha(first.wasm),saved,'prior output immutable');
assert.equal(new WebAssembly.Instance(new WebAssembly.Module(again.wasm),{}).exports.main(),subsequent[2],subsequent[0]);
log('BROWSER_COMPILER '+head+' '+tree+' '+pin);
log('BROWSER_REFINEMENT_VERIFIED '+records.length+' source cases plus reuse control');
return { cases: records.length, reuse: true };

}
