// Browser-only integration gate: synthetic Clang Wasm actor; not Atto-compiled source parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {makeSyntheticAttoActorGuest} from './fixtures/synthetic-atto-integrated-actor.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
function stripUnusedClangTable(input) {
  const parts=[input.subarray(0,8)];let at=8,seen=false;
  while(at<input.length){
    const first=at,id=input[at++];let n=0,shift=0,byte;
    do {if(at>=input.length||shift>28)throw Error('bad Wasm LEB');byte=input[at++];n+=(byte&127)*2**shift;shift+=7;} while(byte&128);
    if(at+n>input.length)throw Error('truncated Wasm fixture');
    if(id===4){
      if(seen||Buffer.compare(input.subarray(at,at+n),Buffer.from('0170010101','hex'))!==0)
        throw Error('unexpected Clang table; test fixture only');
      seen=true;
    } else parts.push(input.subarray(first,at+n));
    at+=n;
  }
  if(!seen)throw Error('expected one unused Clang table');
  const output=Buffer.concat(parts);
  if(!WebAssembly.validate(output))throw Error('normalized fixture is not valid Wasm');
  return output;
}
test('real Chromium: one tenant Worker with two private Wasm32 actor instances',async t=>{
  const scratch=await mkdtemp(join(tmpdir(),'atto-browser-tenant-'));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const source=join(scratch,'actor.c'),out=join(scratch,'actor.wasm');
  await writeFile(source,`static long long state;
__attribute__((export_name("oreslang_wasm_actor_init"))) void initialize(void){state=0;}
__attribute__((export_name("oreslang_wasm_actor_on_message"))) long long receive(long long v){if(v==-1)__builtin_trap();state+=v;return state;}
__attribute__((export_name("oreslang_wasm_actor_teardown"))) void teardown(void){state=0;}
`);
  const compiler=spawnSync('clang',['--target=wasm32','-nostdlib','-O1',source,
    '-Wl,--no-entry','-Wl,--export-memory','-Wl,--initial-memory=131072',
    '-Wl,--max-memory=131072','-o',out],{encoding:'utf8'});
  assert.equal(compiler.status,0,'real Clang wasm32 required: '+(compiler.stderr||compiler.error));
  const binary=stripUnusedClangTable(await readFile(out));
  const sourceAbiBase64=Buffer.from(makeSyntheticAttoActorGuest()).toString('base64');
  const html=`<!doctype html><meta charset="utf-8"><body data-result="pending"><script type="module">
import {BrowserTenantSupervisor} from '/src/browser-tenant-supervisor.mjs';
const bytes=Uint8Array.from(atob('${binary.toString('base64')}'),c=>c.charCodeAt(0));
const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
  b=>b.toString(16).padStart(2,'0')).join('');
const worker=new Worker('/src/browser-tenant-worker.mjs',{type:'module'});
let ticket=0;
const incarnation=new Map([[1,'1'.repeat(32)],[2,'2'.repeat(32)]]);
function ask(id,kind,extra={}){return new Promise((resolve,reject)=>{
 const t=++ticket;
 const timeout=setTimeout(()=>reject(Error('worker request deadline')),1500);
 const onMessage=({data})=>{if(data.ticket!==t)return;
   worker.removeEventListener('message',onMessage);clearTimeout(timeout);resolve(data);};
 worker.addEventListener('message',onMessage);
 worker.postMessage({ticket:t,id,incarnation:incarnation.get(id),kind,...extra});
});}
try {
 for(const id of [1,2]){
  const x=await ask(id,'spawn',{bytes,approvedSha256:digest,trusted:true});
  if(x.kind!=='ack')throw Error('actor spawn: '+x.reason);
 }
 const results=[];
 for(const [id,v] of [[1,5n],[2,10n],[1,2n],[2,1n]]) {
  const x=await ask(id,'send',{value:v});
  if(x.kind!=='ack')throw Error('actor turn: '+x.reason);
  results.push(x.result.toString());
 }
 if(results.join('|')!=='5|10|7|11')throw Error('cross-actor state leak: '+results.join('|'));
 if((await ask(1,'stop')).kind!=='ack')throw Error('stop not acknowledged');
 incarnation.set(1,'3'.repeat(32));
 if((await ask(1,'spawn',{bytes,approvedSha256:digest,trusted:true})).kind!=='ack')
   throw Error('reincarnation not acknowledged');
 if((await ask(1,'send',{incarnation:'1'.repeat(32),value:100n})).kind!=='rejected')
   throw Error('stale actor handle was not rejected');
 if((await ask(1,'send',{value:3n})).result!==3n)throw Error('old actor state leaked');
 if((await ask(2,'send',{value:1n})).result!==12n)throw Error('neighbor state lost');
 // Real browser parent supervisor: two actors in ONE tenant Worker; a third
 // actor in a DIFFERENT Worker. A pinned synthetic fixture is trusted in this
 // test only. User-supplied hashes are never production authorization.
 const manifest=[{name:'reviewed-fixture',bytes,sha256:digest}];
 const tenantA=new BrowserTenantSupervisor({workerUrl:'/src/browser-tenant-worker.mjs',
   manifest,deadlineMs:2500});
 const tenantB=new BrowserTenantSupervisor({workerUrl:'/src/browser-tenant-worker.mjs',
   manifest,deadlineMs:2500});
 try {
   const x=await tenantA.spawn(1,'reviewed-fixture');
   const y=await tenantA.spawn(2,'reviewed-fixture');
   const z=await tenantB.spawn(1,'reviewed-fixture');
   if(await tenantA.send(x,5n)!==5n || await tenantA.send(y,10n)!==10n ||
      await tenantA.send(x,2n)!==7n || await tenantA.send(y,1n)!==11n ||
      await tenantB.send(z,3n)!==3n)throw Error('supervised actors leaked state');
   let crossDenied=false;
   try {await tenantB.send(x,1n);}catch{crossDenied=true;}
   if(!crossDenied)throw Error('cross-tenant capability was accepted');
   let faultDenied=false;
   try {await tenantA.send(x,-1n);}catch(e){faultDenied=/actor-local/.test(String(e));}
   if(!faultDenied || tenantA.closed)throw Error('actor-local fault poisoned whole tenant');
   if(await tenantA.send(y,1n)!==12n)throw Error('neighbor corrupted by actor fault');
   if(await tenantB.send(z,1n)!==4n)throw Error('second tenant corrupted by fault');
   const replacement=await tenantA.spawn(1,'reviewed-fixture');
   let staleDenied=false;
   try {await tenantA.send(x,1n);}catch{staleDenied=true;}
   if(!staleDenied || await tenantA.send(replacement,3n)!==3n)
     throw Error('retired actor identity or memory was reused');
 } finally {tenantA.close();tenantB.close();}
 // The separate Rust integrated actor ABI is tested in actual Chromium with
 // source-shaped, hand-encoded Wasm. No Rust compiler-produced binary is
 // distributed or claimed by this synthetic fixture.
 const attoBytes=Uint8Array.from(atob('${sourceAbiBase64}'),c=>c.charCodeAt(0));
 const attoDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',attoBytes)),
   b=>b.toString(16).padStart(2,'0')).join('');
 const attoManifest=[
   {name:'handler-zero',bytes:attoBytes,sha256:attoDigest,
     profile:'atto.browser.actor.integrated.v1',actorId:0},
   {name:'handler-one',bytes:attoBytes,sha256:attoDigest,
     profile:'atto.browser.actor.integrated.v1',actorId:1}
 ];
 const sourceTenantA=new BrowserTenantSupervisor({workerUrl:'/src/browser-atto-tenant-worker.mjs',
   manifest:attoManifest,deadlineMs:2500});
 const sourceTenantB=new BrowserTenantSupervisor({workerUrl:'/src/browser-atto-tenant-worker.mjs',
   manifest:attoManifest,deadlineMs:2500});
 try {
   const a=await sourceTenantA.spawn(1,'handler-zero');
   const b=await sourceTenantA.spawn(2,'handler-one');
   const c=await sourceTenantB.spawn(1,'handler-zero');
   if(await sourceTenantA.send(a,5n)!==5n ||
      await sourceTenantA.send(b,10n)!==10n ||
      await sourceTenantA.send(a,2n)!==7n ||
      await sourceTenantA.send(b,1n)!==11n ||
      await sourceTenantB.send(c,3n)!==3n)
     throw Error('source-shaped Atto actor receiver state isolation failed');
   let cross=false;
   try {await sourceTenantB.send(a,1n);}catch{cross=true;}
   if(!cross)throw Error('integrated actor capability crossed tenant');
   let fault=false;
   try {await sourceTenantA.send(a,-1n);}catch(e){fault=/actor-local/.test(String(e));}
   if(!fault||sourceTenantA.closed)throw Error('integrated actor fault poisoned neighbor');
   if(await sourceTenantA.send(b,1n)!==12n ||
      await sourceTenantB.send(c,1n)!==4n)
     throw Error('healthy integrated actor did not survive neighbor trap');
   const revived=await sourceTenantA.spawn(1,'handler-zero');
   let stale=false;
   try {await sourceTenantA.send(a,1n);}catch{stale=true;}
   if(!stale || await sourceTenantA.send(revived,3n)!==3n)
     throw Error('integrated actor reincarnation leaked old state');
 } finally {sourceTenantA.close();sourceTenantB.close();}
 document.body.dataset.result='pass';
} catch(e) {document.body.dataset.result='fail';document.body.textContent=String(e?.message||e);}
finally{worker.terminate();}
</script>`;
  const server=createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end(html);return;}
    if(!/^\/(?:src|scripts)\/[a-z0-9-]+\.mjs$/.test(pathname)){
      res.writeHead(404).end();return;
    }
    const path=resolve(ROOT,'.'+pathname);
    if(!path.startsWith(ROOT+'/')){res.writeHead(403).end();return;}
    res.setHeader('Content-Type','text/javascript');
    try{res.end(await readFile(path));}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/`;
  // CDP polling waits for actual async Worker completion instead of relying
  // on --dump-dom's virtual-time snapshot of a still-running page.
  const profile=join(scratch,'chromium-profile');
  const chrome=spawn(process.env.CHROME_BIN||'chromium',[
    '--headless=new','--no-sandbox','--disable-gpu',
    '--disable-dev-shm-usage','--no-first-run','--no-proxy-server',
    '--disable-background-networking','--remote-debugging-port=0',
    '--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let stderr='',ws=null;
  chrome.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  try {
    let port=0;
    for(let i=0;i<100;i++) {
      if(chrome.exitCode!==null)throw Error('Chromium exited: '+stderr);
      try{
        port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(String.fromCharCode(10))[0]);
        if(port>0)break;
      }catch{}
      await sleep(100);
    }
    if(!port)throw Error('Chromium CDP not ready: '+stderr);
    const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    const page=targets.find(x=>x.type==='page'&&x.webSocketDebuggerUrl);
    assert.ok(page,'Chromium page target required');
    ws=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{
      ws.addEventListener('open',resolve,{once:true});
      ws.addEventListener('error',reject,{once:true});
    });
    let serial=0;
    const pending=new Map();
    ws.addEventListener('message',event=>{
      const r=JSON.parse(event.data);
      if(!pending.has(r.id))return;
      const entry=pending.get(r.id);pending.delete(r.id);
      if(r.error)entry.reject(Error(r.error.message));else entry.resolve(r.result);
    });
    const command=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++serial;pending.set(id,{resolve,reject});
      ws.send(JSON.stringify({id,method,params}));
    });
    const evaluate=async expression=>{
      const r=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails)throw Error(r.exceptionDetails.text);
      return r.result?.value;
    };
    await command('Page.enable');await command('Runtime.enable');
    const nav=await command('Page.navigate',{url});
    assert.ok(!nav.errorText,nav.errorText||'navigation failed');
    let status='pending';
    for(let i=0;i<200;i++){
      status=await evaluate('document.body?.dataset?.result');
      if(status==='pass'||status==='fail')break;
      await sleep(100);
    }
    const reason=await evaluate('document.body?.textContent?.slice(0,1500)');
    assert.equal(status,'pass','real Chromium multi-tenant browser test: '+status+' '+reason);
  } finally {
    try{ws?.close();}catch{}
    chrome.kill('SIGKILL');
  }
});
