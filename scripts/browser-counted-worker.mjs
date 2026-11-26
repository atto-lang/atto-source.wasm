import {createCompiler,verifyCompilerBytes} from '../src/canonical-browser-compiler.mjs';
const eq=(a,b,label)=>{if(a!==b)throw Error(label+': '+String(a)+' != '+String(b));};
self.onmessage=async({data})=>{
 try{
  if(!(self instanceof DedicatedWorkerGlobalScope)||typeof document!=='undefined'||!self.isSecureContext)throw Error('expected secure dedicated browser Worker');
  const response=await fetch('/compiler.wasm',{cache:'no-store'});if(!response.ok)throw Error('compiler fetch failed');
  const bytes=new Uint8Array(await response.arrayBuffer());
  let denied=false;const wrong=(data.pin[0]==='0'?'1':'0')+data.pin.slice(1);
  try{await verifyCompilerBytes(bytes,wrong,bytes.length);}catch(e){denied=/sha256/.test(e.message);}
  eq(denied,true,'digest denial');await verifyCompilerBytes(bytes,data.pin,bytes.length);
  const c=await createCompiler(bytes);
  self.postMessage({line:'BROWSER_COMPILER '+data.head+' '+data.tree+' '+data.pin});
  for(const x of data.cases){
   const ordinary=c.compile(x.source);eq(ordinary.ok,false,x.id+' ordinary admission');eq('wasm' in ordinary,false,'ordinary artifact');
   const r=c.compile(x.source,'wasm','counted-ready-v1');eq(r.ok,x.positive,x.id+' profile');
   if(x.positive){
    const m=new WebAssembly.Module(r.wasm);eq(WebAssembly.Module.imports(m).length,0,'no imports');
    const g=new WebAssembly.Instance(m,{}).exports,other=new WebAssembly.Instance(m,{}).exports;
    eq('memory' in g,false,'private memory');eq(g.main(),42n,x.id);eq(g.main(),42n,'repeat');eq(other.main(),42n,'independent instance');eq(g.panic_code.value,0,'panic');
   }else{eq('wasm' in r,false,'negative artifact');if(!r.diagnostics.length)throw Error('missing diagnostic');}
   self.postMessage({line:'PASS counted-browser '+x.id});
  }
  const prefix='suspends fnc main(): int { val Channel<int> a = Channel.new<int>(1); ';
  const checks=[
    ['writech a, 42; val Array[int] b = await select<int>(1) { when readch a: int n -> { return n; } }; return b[1]; }',10],
    ['val int count = 17; val Array[int] b = await select<int>(count) { when readch a: int n -> { return n; } }; return b[0]; }',8],
    ['writech a, 42; val Future<Array<int>> pending = select<int>(1) { when readch a: int n -> { return n; } }; val int x = 9223372036854775807 + 1; val Array[int] b = await pending; return b[0]; }',1],
    ['val Array[int] b = await select<int>(0) { when readch a: int n -> { return n; } }; return readch a; }',9],
    ['val Array[int] b = await select<int>(1) { when readch a: int n -> { return n; } }; return b[0]; }',9],
    ['writech a, 42; writech a, 43; val Array[int] b = await select<int>(1) { when readch a: int n -> { return n; } }; return b[0]; }',9]
  ];
  for(const [body,panic] of checks){
    const r=c.compile(prefix+body,'wasm','counted-ready-v1');eq(r.ok,true,JSON.stringify(r.diagnostics));const g=new WebAssembly.Instance(new WebAssembly.Module(r.wasm),{}).exports;
    let trapped=false;try{g.main()}catch(e){trapped=e instanceof WebAssembly.RuntimeError;}eq(trapped,true,'native Wasm trap');eq(g.panic_code.value,panic,'panic code');
  }
  const normal=c.compile('pub fnc main(): int { return 42; }');eq(normal.ok,true,'compiler reuse');eq(new WebAssembly.Instance(new WebAssembly.Module(normal.wasm),{}).exports.main(),42n,'normal control');
  self.postMessage({ok:true,worker:true,agent:navigator.userAgent,integrityNegative:true,reuse:true,cases:data.cases.length,runtimeControls:6,ordinaryDenials:data.cases.length});
 }catch(e){self.postMessage({ok:false,error:String(e?.stack??e)});}
};
