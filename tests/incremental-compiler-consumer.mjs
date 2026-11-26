// Real upstream compiler artifact gate. The browser guest ABI differs from
// the strict native core Wasm ABI. Never weaken that strict admission gate.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {runIsolatedCoreGuest} from '../src/isolated-runner.mjs';
import {admit_browser_guest} from '../src/browser-tenant-guest-admission.mjs';
import {runCanonicalGuest} from '../src/browser-tenant-runtime.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
if(!isMainThread){
  try{
    assert.equal(Object.keys(process.env).length,0);
    const {bytes,pin}=workerData;
    if(sha(bytes)!==pin)throw Error('E_PIN: stale artifact pin');
    const admitted=admit_browser_guest(bytes);
    assert.equal(sha(admitted.bytes),pin);
    assert.deepEqual(admitted.imports,[]);
    assert.equal(admitted.actors,false);
    const result=runCanonicalGuest({actorNames:[],instantiate:()=>new WebAssembly.Instance(admitted.module,{})});
    assert.equal(result.ok,true,result.message);parentPort.postMessage({ok:true,value:result.value});
  }catch(error){parentPort.postMessage({ok:false,error:String(error?.message||error)});}
}else{
 const [coldPath,warmPath,editPath]=process.argv.slice(2);
 if(!coldPath||!warmPath||!editPath||process.argv.length!==5)throw Error('expected cold, warm, edited compiler artifact paths');
 const [cold,warm,edit]=await Promise.all([coldPath,warmPath,editPath].map(p=>readFile(p)));
 assert.deepEqual(cold,warm);assert.notDeepEqual(cold,edit);
 const coldPin=sha(cold),editPin=sha(edit);
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
 for(const [bytes,pin,expected] of [[cold,coldPin,'42'],[warm,coldPin,'42'],[edit,editPin,'43']])
   assert.equal(await execute(bytes,pin),expected);
 await assert.rejects(execute(edit,coldPin),/E_PIN/);
 console.log('INCREMENTAL_WASM_CONSUMER|actual-browser-worker-guests=42/42/43|stale-pin-denied|strict-native-abi-denial-preserved');
}
