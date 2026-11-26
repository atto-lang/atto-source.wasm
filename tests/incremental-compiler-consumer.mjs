// Real upstream compiler artifact gate. The browser guest ABI differs from
// the strict native core Wasm ABI. Never weaken that strict admission gate.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
import {admit_pinned_browser_guest} from '../src/browser-tenant-guest-admission.mjs';
import {runCanonicalGuest} from '../src/browser-tenant-runtime.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
if(!isMainThread){
  try{
    assert.equal(Object.keys(process.env).length,0);
    const {bytes,pin}=workerData;
    const admitted=await admit_pinned_browser_guest(bytes,pin);
    assert.equal(sha(admitted.bytes),pin);
    const exposed=admitted.bytes; exposed[0]^=1;
    assert.equal(sha(admitted.bytes),pin);
    assert.deepEqual(admitted.imports,[]);
    assert.equal(admitted.actors,false);
    const result=runCanonicalGuest({actorNames:[],instantiate:()=>new WebAssembly.Instance(admitted.module,{})});
    assert.equal(result.ok,true,result.message);parentPort.postMessage({ok:true,value:result.value});
  }catch(error){parentPort.postMessage({ok:false,error:String(error?.message||error)});}
}else{
 const args=process.argv.slice(2);
 const v3=args[0]==='--v3';if(v3)args.shift();
 const [coldPath,warmPath,editPath,observerPath,observerEditPath]=args;
 if(args.length!==(v3?5:3)||args.some(x=>!x))throw Error('expected exact compiler artifact paths');
 const [cold,warm,edit]=await Promise.all([coldPath,warmPath,editPath].map(p=>readFile(p)));
 assert.deepEqual(cold,warm);assert.notDeepEqual(cold,edit);
 const coldPin=sha(cold),editPin=sha(edit);
 const mutable=new Uint8Array(cold);
 const pending=admit_pinned_browser_guest(mutable,coldPin);
 mutable[0]^=1;
 const snapshot=await pending;
 assert.equal(sha(snapshot.bytes),coldPin);
 await assert.rejects(admit_pinned_browser_guest(mutable,sha(mutable)),/E_WASM_INVALID/);
 await assert.rejects(admit_pinned_browser_guest(cold,'invalid'),/E_PIN/);
 console.log('PINNED_BROWSER_SNAPSHOT|caller_mutation=ISOLATED|rehashed_invalid=DENIED|malformed_pin=DENIED');
 function execute(bytes,pin){
   return new Promise((resolve,reject)=>{
     const worker=new Worker(new URL(import.meta.url),{workerData:{bytes,pin},env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:32}});
     let done=false;
     const finish=(error,value)=>{
       if(done)return;done=true;clearTimeout(timer);
       worker.terminate().then(()=>error?reject(error):resolve(value),reject);
     };
     const timer=setTimeout(()=>finish(Error('deadline')),5000);
     worker.once('message',m=>m.ok?finish(null,m.value):finish(Error(m.error)));
     worker.once('error',e=>finish(e));
     worker.once('exit',()=>finish(Error('worker exited without result')));
   });
 }
 // Preserve the original strict native ABI rejection for memory-free browser
 // output. Use the correct existing browser runtime profile, not a fallback.
 await assert.rejects(runIsolatedCoreGuest(cold,{expectedSha256:coldPin,timeoutMs:5000}),/exactly one privately defined, bounded linear memory/);
 for(const [bytes,pin,expected] of [[cold,coldPin,v3?'10203':'42'],[warm,coldPin,v3?'10203':'42'],[edit,editPin,v3?'42010203':'43']])
   assert.equal(await execute(bytes,pin),expected);
 await assert.rejects(execute(edit,coldPin),/E_PIN/);
 if(v3){
   const [observer,observerEdit]=await Promise.all([observerPath,observerEditPath].map(p=>readFile(p)));
   assert.deepEqual(observer,observerEdit);const observerPin=sha(observer);
   for(const bytes of [observer,observerEdit])assert.equal(await execute(bytes,observerPin),'40506');
   await assert.rejects(execute(observer,coldPin),/E_PIN/);
   console.log('V3_WASM_CONSUMER|actual-browser-worker-guests=10203/10203/42010203/40506/40506|observer-byte-stable|stale-pin-denied|strict-native-abi-denial-preserved');
 }else console.log('INCREMENTAL_WASM_CONSUMER|actual-browser-worker-guests=42/42/43|stale-pin-denied|strict-native-abi-denial-preserved');
}
