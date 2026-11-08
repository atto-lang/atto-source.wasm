/**
 * Opt-in, non-deploying Chromium E2E: independently pinned Rust compiler Wasm
 * compiles real .atto source IN THE BROWSER, then guest Wasm executes across
 * two private instances inside ONE tenant Worker and one separate tenant.
 * Requires exact compiler binary/source approval env (see helper).
 *
 * A locally served compiler binary is confined to 127.0.0.1 test server and
 * is NEVER copied to GitHub Pages or retained as a workflow artifact here.
 * This test does not grant independent review/disclosure approval.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileApprovedAttoSource,TWO_ATTO_ACTORS}
  from './helpers/approved-atto-compiler.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('real Chromium: Rust compiler-as-Wasm compiles .atto; 2 guest actors/tenant Worker',async t=>{
  const receipt=await compileApprovedAttoSource();
  const compiler=await readFile(process.env.ATTO_COMPILER_WASM);
  const dir=await mkdtemp(join(tmpdir(),'atto-real-compiler-browser-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const html=`<!doctype html><meta charset="utf-8"><body data-result="pending">
<script type="module">
import {BrowserTenantSupervisor} from '/src/browser-tenant-supervisor.mjs';
try {
  const compilerBytes=new Uint8Array(await (await fetch('/approved-compiler.wasm')).arrayBuffer());
  const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
  if(hex(await crypto.subtle.digest('SHA-256',compilerBytes))!=='${receipt.compilerSha256}')
    throw Error('browser compiler identity differs from approved binary');
  const module=await WebAssembly.compile(compilerBytes);
  if(WebAssembly.Module.imports(module).length)throw Error('compiler imported host capability');
  const api=(await WebAssembly.instantiate(module,{})).exports;
  if(api.abi_version()!==2)throw Error('compiler ABI mismatch');
  const sourceBytes=new TextEncoder().encode(${JSON.stringify(TWO_ATTO_ACTORS)});
  const inPtr=api.input_ptr();
  if(sourceBytes.length>api.input_capacity()||
     inPtr+sourceBytes.length>api.memory.buffer.byteLength)
    throw Error('compiler input pointer out of bounds');
  new Uint8Array(api.memory.buffer,inPtr,sourceBytes.length).set(sourceBytes);
  if(api.compile(sourceBytes.length)!==0) {
    const mem=new Uint8Array(api.memory.buffer),at=api.error_ptr();
    let end=at;
    while(end<mem.length&&mem[end]&&end-at<256)end++;
    throw Error('browser Rust compiler rejected source: '+
      new TextDecoder().decode(mem.subarray(at,end)));
  }
  const start=api.result_ptr(),n=api.result_length();
  if(n<=0||n>1048576||start+n>api.memory.buffer.byteLength)
    throw Error('browser compiler result out of bounds');
  const guest=Uint8Array.from(new Uint8Array(api.memory.buffer,start,n));
  if(!WebAssembly.validate(guest))throw Error('browser compiler emitted invalid guest');
  const sha=hex(await crypto.subtle.digest('SHA-256',guest));
  if(sha!=='${receipt.guestSha256}')
    throw Error('Node-vs-browser compiler output drift');
  const manifest=[{name:'approved-source-actor',bytes:guest,sha256:sha,
    profile:'atto.browser.actor.integrated.v1',actorId:0}];
  const mk=()=>new BrowserTenantSupervisor({
    workerUrl:'/src/browser-atto-tenant-worker.mjs',manifest,deadlineMs:5000
  });
  const a=mk(),b=mk();
  try {
    const x=await a.spawn(1,'approved-source-actor');
    const y=await a.spawn(2,'approved-source-actor');
    const z=await b.spawn(1,'approved-source-actor');
    const values=[await a.send(x,41n),await a.send(y,42n),
      await a.send(x,43n),await b.send(z,44n)];
    if(values.map(String).join('|')!=='42|43|44|45')
      throw Error('actual .atto actor reply mismatch: '+values.join('|'));
    let cross=false;
    try {await b.send(x,1n);}catch{cross=true;}
    if(!cross)throw Error('cross-tenant actor reference accepted');
    await a.stop(x);
    let stale=false;
    try{await a.send(x,1n);}catch{stale=true;}
    if(!stale)throw Error('stale Atto actor generation was accepted');
    const fresh=await a.spawn(1,'approved-source-actor');
    if(await a.send(fresh,41n)!==42n||
       await a.send(y,42n)!==43n||
       await b.send(z,44n)!==45n)
      throw Error('Atto actor reincarnation/neighbor continuity failure');
  } finally {a.close();b.close();}
  document.body.dataset.receipt=sha;
  document.body.dataset.result='pass';
} catch(error) {
  document.body.dataset.result='fail';
  document.body.textContent=String(error?.message||error);
}
</script>`;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost').pathname;
    if(req.method!=='GET'){res.writeHead(405).end();return;}
    if(url==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
    if(url==='/approved-compiler.wasm'){
      res.setHeader('Content-Type','application/wasm');
      res.end(compiler);return;
    }
    const parts=url.split('/');
    if(parts.length!==3||!['src','scripts'].includes(parts[1])||
       !/^[a-z0-9-]+[.]mjs$/.test(parts[2])){
      res.writeHead(404).end();return;
    }
    const file=resolve(ROOT,'.'+url);
    if(!file.startsWith(ROOT+'/')){res.writeHead(403).end();return;}
    try {res.setHeader('Content-Type','text/javascript');res.end(await readFile(file));}
    catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const profile=join(dir,'chromium-profile');
  const chrome=spawn(process.env.CHROME_BIN||'chromium',[
    '--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
    '--no-first-run','--no-proxy-server','--disable-background-networking',
    '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],
    {stdio:['ignore','ignore','pipe']});
  let stderr='',ws=null;
  chrome.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
  try {
    let port=0;
    for(let i=0;i<100;i++){
      if(chrome.exitCode!==null)throw Error('Chromium exited: '+stderr);
      try{
        port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8'))
          .split(String.fromCharCode(10))[0]);
        if(port>0)break;
      }catch{}
      await sleep(100);
    }
    if(!port)throw Error('Chromium CDP did not start: '+stderr);
    const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    const page=targets.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);
    assert.ok(page,'Chromium page target required');
    ws=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{
      ws.addEventListener('open',resolve,{once:true});
      ws.addEventListener('error',reject,{once:true});
    });
    let serial=0;const pending=new Map();
    ws.addEventListener('message',event=>{
      const r=JSON.parse(event.data);
      if(!pending.has(r.id))return;
      const x=pending.get(r.id);pending.delete(r.id);
      if(r.error)x.reject(Error(r.error.message));else x.resolve(r.result);
    });
    const command=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++serial;pending.set(id,{resolve,reject});
      ws.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const r=await command('Runtime.evaluate',
        {expression,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails)throw Error(r.exceptionDetails.text);
      return r.result?.value;
    };
    await command('Page.enable');await command('Runtime.enable');
    const nav=await command('Page.navigate',
      {url:'http://127.0.0.1:'+server.address().port+'/'});
    assert.ok(!nav.errorText,nav.errorText||'navigation failed');
    let status='pending';
    for(let i=0;i<250;i++){
      status=await evaluate('document.body?.dataset?.result');
      if(['pass','fail'].includes(status))break;
      await sleep(100);
    }
    const error=await evaluate('document.body?.textContent?.slice(0,1600)');
    assert.equal(status,'pass','actual Atto Chromium E2E: '+status+' '+error);
    assert.equal(await evaluate('document.body.dataset.receipt'),receipt.guestSha256);
    console.log(JSON.stringify({sourceHead:receipt.sourceHead,sourceTree:receipt.sourceTree,
      compilerSha256:receipt.compilerSha256,guestSha256:receipt.guestSha256,
      guestAbi:'atto.browser.actor.integrated.v1',browser:'Chromium',
      tenants:2,independentActorInstances:3}));
  } finally {
    try{ws?.close();}catch{}
    chrome.kill('SIGKILL');
  }
});
