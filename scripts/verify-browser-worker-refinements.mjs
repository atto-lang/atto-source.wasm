// Real headless Chrome, no Node Worker or mocked compiler fallback.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const [path,pin,head,tree,chrome,corpus]=process.argv.slice(2);
if(!path||!chrome||!/^[a-f0-9]{64}$/.test(pin??'')||!/^[a-f0-9]{40}$/.test(head??'')||!/^[a-f0-9]{40}$/.test(tree??''))throw Error('usage: node scripts/verify-browser-worker-refinements.mjs compiler.wasm sha256 head tree chrome');
const bytes=await readFile(path);
assert.ok(bytes.length>8&&bytes.length<=16*1024*1024);
const profile=await mkdtemp(join(tmpdir(),'atto-worker-chrome-'));
const routes=new Map([
 ['/scripts/browser-refinement-worker.mjs',new URL('./browser-refinement-worker.mjs',import.meta.url)],
 ['/scripts/browser-refinement-corpus.mjs',new URL('./browser-refinement-corpus.mjs',import.meta.url)],
 ['/src/canonical-browser-compiler.mjs',new URL('../src/canonical-browser-compiler.mjs',import.meta.url)]
]);
if(corpus)routes.set('/typed-binding-corpus.mjs',pathToFileURL(resolve(corpus)));
const page=`<!doctype html><meta charset="utf-8"><script type="module">
const worker=new Worker('/scripts/browser-refinement-worker.mjs',{type:'module'});
const lines=[];let done=false;
async function finish(result){if(done)return;done=true;worker.terminate();await fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({result,lines})});}
worker.onmessage=({data})=>{if(typeof data.line==='string'){if(lines.length<128)lines.push(data.line);}else finish(data);};
worker.onerror=e=>finish({ok:false,error:e.message});
worker.onmessageerror=()=>finish({ok:false,error:'message deserialization error'});
worker.postMessage(${JSON.stringify({pin,head,tree,typed:Boolean(corpus)})});
</script>`;
let resolveResult,rejectResult;
const resultPromise=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
const server=createServer(async(req,res)=>{
 try{
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(page);}
  else if(req.method==='GET'&&req.url==='/compiler.wasm'){res.writeHead(200,{'content-type':'application/wasm','cache-control':'no-store'});res.end(bytes);}
  else if(req.method==='GET'&&routes.has(req.url)){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(await readFile(routes.get(req.url)));}
  else if(req.method==='POST'&&req.url==='/result'){
   let data='';for await(const chunk of req){data+=chunk;if(data.length>65536)throw Error('receipt too large');}
   const receipt=JSON.parse(data);res.writeHead(204);res.end();resolveResult(receipt);
  }else{res.writeHead(404);res.end();}
 }catch(e){res.destroy();rejectResult(e);}
});
let child,timer;
try{
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const url='http://127.0.0.1:'+server.address().port+'/';
 child=spawn(chrome,['--headless=new','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--user-data-dir='+profile,url],{stdio:['ignore','ignore','pipe'],detached:process.platform!=='win32'});
 let stderr='';child.stderr.on('data',x=>{stderr=(stderr+x).slice(-8000);});
 child.once('error',rejectResult);child.once('exit',(code,signal)=>rejectResult(Error('Chrome exited before receipt: '+code+'/'+signal+' '+stderr)));
 timer=setTimeout(()=>rejectResult(Error('browser Worker timed out: '+stderr)),90000);
 const {result,lines}=await resultPromise;
 assert.equal(result.ok,true,result.error);
 assert.equal(result.worker,true);assert.match(result.agent,/Chrome\//);
 assert.equal(result.integrityNegative,true);assert.equal(result.reuse,true);assert.equal(result.cases,corpus?24:23);
 const passes=lines.filter(l=>l.startsWith('PASS browser-abi '));
 assert.equal(passes.length,result.cases);assert.equal(new Set(passes.map(l=>l.split(' ')[2])).size,result.cases);
 assert.ok(lines.includes('BROWSER_COMPILER '+head+' '+tree+' '+pin));
 for(const l of lines)console.log(l);
 console.log('REAL_BROWSER_WORKER_PASS '+result.cases+' source cases; reuse and digest denial; '+result.agent);
}finally{
 clearTimeout(timer);
 if(child?.pid&&process.platform!=='win32'){
   // Kill the dedicated process group, including Chrome renderer children.
   try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}
 }
 if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit').catch(()=>{});child.kill('SIGKILL');await exited;}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await rm(profile,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
