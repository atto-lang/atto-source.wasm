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
 const records=typedCases===null?cases.map(([id,body,want])=>[id,pre+'\n'+body,want]):typedCases.map(({source,text,expected})=>{
   assert.match(source,/^generated-binding-[a-z-]+\.atto$/);
   assert.ok(typeof text==="string");
   if(expected.kind==="diagnostic")return [source,text,expected.category];
   if(expected.kind==="value")return [source,text,BigInt(expected.decimal)];
   assert.ok(["arithmeticFailure","refinementFailure"].includes(expected.kind)&&Object.hasOwn(codes,expected.category),source);
   return [source,text,codes[expected.category]];
 });
 if(typedCases!==null)assert.equal(records.length,24);
 assert.equal(new Set(records.map(x=>x[0])).size,records.length);
 for(const [id,source,want] of records){
 const result=compiler.compile(source);
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
const first=compiler.compile(pre+'\n'+main('42'));
assert.equal(first.ok,true);
const saved=await sha(first.wasm);
assert.equal(compiler.compile(pre+'\n'+main('missing')).ok,false);
const again=compiler.compile(pre+'\n'+main('43'));
assert.equal(again.ok,true);
assert.equal(await sha(first.wasm),saved);
assert.equal(new WebAssembly.Instance(new WebAssembly.Module(again.wasm),{}).exports.main(),43n);
log('BROWSER_COMPILER '+head+' '+tree+' '+pin);
log('BROWSER_REFINEMENT_VERIFIED '+records.length+' source cases plus reuse control');
return { cases: records.length, reuse: true };

}
