import assert from 'node:assert/strict';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';

export function observeGuest(bytes,expected){
  if(expected.kind==='compile'){
    // This branch is handled before instantiation by the compiler worker.
    throw new Error('compile-only guest must not be instantiated');
  }
  assert.ok(WebAssembly.validate(bytes),'invalid guest');
  const mod=new WebAssembly.Module(bytes);
  assert.deepEqual(WebAssembly.Module.imports(mod),[],'unexpected guest imports');
  const guest=new WebAssembly.Instance(mod,{});
  const {main,panic_code:panic}=guest.exports;
  assert.equal(typeof main,'function');
  assert.ok(panic instanceof WebAssembly.Global);
  assert.equal(panic.value,0,'dirty initial panic state');
  if(expected.kind==='value'){
    for(let i=0;i<3;i++){
      assert.equal(main(),BigInt(expected.value),'wrong signed i64 value');
      assert.equal(panic.value,0);
    }
    return {kind:'value',value:expected.value,repetitions:3};
  }
  assert.equal(expected.kind,'panic');
  assert.throws(()=>main(),WebAssembly.RuntimeError);
  assert.equal(panic.value,expected.code,'wrong language panic');
  return {kind:'panic',code:panic.value};
}
export function runBounded(data,timeoutMs=15000){
  assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>=10&&timeoutMs<=60000);
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{
      workerData:data,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:96,stackSizeMb:4}
    });
    let settled=false;
    const finish=(err,value)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      void worker.terminate().then(()=>err?reject(err):resolve(value),reject);
    };
    const timer=setTimeout(()=>finish(new Error('E_BROWSER_PROOF_TIMEOUT')),timeoutMs);
    worker.once('message',m=>m.ok?finish(null,m.result):finish(new Error(m.error)));
    worker.once('error',e=>finish(e));
    worker.once('exit',code=>finish(new Error('E_BROWSER_PROOF_EXIT '+code)));
  });
}
if(!isMainThread){
  try{
    let result;
    if(workerData.kind==='guest-control'){
      result=observeGuest(workerData.bytes,workerData.expected);
    }else if(workerData.kind==='compiler'){
      const {createCompiler}=await import('../src/canonical-browser-compiler.mjs');
      const compiler=await createCompiler(workerData.compilerBytes);
      const cases=[];
      for(const {id,source,expected} of workerData.cases){
        const compiled=compiler.compile(source);
        if(expected.kind==='reject'){
          assert.equal(compiled.ok,false,id);
          assert.equal(Object.hasOwn(compiled,'wasm'),false,id);
          assert.equal(Object.hasOwn(compiled,'esm'),false,id);
          assert.equal(compiled.diagnostics.length,1,id);
          const d=compiled.diagnostics[0];
          assert.ok(d.message.startsWith(expected.code+':'),JSON.stringify(d));
          assert.equal(d.line,expected.line,id);
          cases.push({id,kind:'reject',code:expected.code,line:d.line});
          const next=compiler.compile('pub fnc main(): int { return 42; }');
          assert.equal(next.ok,true,JSON.stringify(next.diagnostics));
          observeGuest(next.wasm,{kind:'value',value:'42'});
        }else{
          assert.equal(compiled.ok,true,id+': '+JSON.stringify(compiled.diagnostics));
          assert.deepEqual(compiled.diagnostics,[]);
          if(expected.kind==='compile'){
            const mod=new WebAssembly.Module(compiled.wasm);
            assert.deepEqual(WebAssembly.Module.imports(mod),[]);
            assert.ok(WebAssembly.Module.exports(mod).some(e=>e.name==='main'&&e.kind==='function'));
            cases.push({id,kind:'compile'});
          }else{
            cases.push({id,...observeGuest(compiled.wasm,expected)});
          }
        }
      }
      result=cases;
    }else throw new Error('unknown proof mode');
    parentPort.postMessage({ok:true,result});
  }catch(e){parentPort.postMessage({ok:false,error:String(e?.stack??e)});}
}
