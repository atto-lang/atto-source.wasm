import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {TenantHostedIoV1, HostIoError} from '../runtime/hosted-io-v1.mjs';

function rejectCode(code) {
  return error => error instanceof HostIoError && error.code === code;
}
async function serverForTest() {
  const server = createServer((req, res) => {
    const url = req.url;
    if (url === '/data') {
      res.writeHead(200, {'content-type':'text/plain; charset=utf-8'});
      res.end('héllo 🌎');
    } else if (url === '/missing') {
      res.writeHead(404); res.end('not found');
    } else if (url === '/redirect') {
      res.writeHead(302, {location:'/data'}); res.end();
    } else if (url === '/bad') {
      res.writeHead(200); res.end(Buffer.from([0xc3, 0x28]));
    } else if (url === '/large') {
      res.writeHead(200); res.end('z'.repeat(400));
    } else if (url === '/chunked') {
      res.writeHead(200); res.write('hé'); res.end('llo 🌎');
    } else if (url === '/slow') {
      res.writeHead(200); res.flushHeaders();
      setTimeout(() => { if (!res.destroyed) res.end('late'); }, 150);
    } else { res.writeHead(500); res.end('unexpected'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {server, origin: 'http://127.0.0.1:' + address.port};
}

test('real loopback HTTP -> tenant-virtual FS read/write -> strict UTF-8 roundtrip', async t => {
  const {server, origin} = await serverForTest();
  t.after(() => server.close());
  const grants = [origin];
  const vm = new TenantHostedIoV1({tenantId:'tenant-a', allowedOrigins:grants});
  grants.push('https://example.com'); // no grant mutation after construction
  const actor = vm.open_actor(1,1,{network:true,read:true,write:true});
  const response = await vm.request_text(actor, origin + '/data');
  assert.equal(response.status, 200);
  assert.equal(response.text, 'héllo 🌎');
  await vm.write_text(actor, './response.txt', response.text);
  assert.equal(await vm.read_text(actor, './response.txt'), 'héllo 🌎');
  assert.equal((await vm.read_text(actor,'response.txt')).length, 'héllo 🌎'.length);
  assert.equal(vm.file_count, 1);
  assert.equal(vm.byte_count, Buffer.byteLength(response.text));
  const missing = await vm.request_text(actor, origin + '/missing');
  assert.equal(missing.status,404);
  assert.equal(missing.text,'not found');
  assert.equal((await vm.request_text(actor,origin + '/chunked')).text,'héllo 🌎');
  await assert.rejects(vm.request_text(actor,'https://example.com/data'),rejectCode('E_NET_PERMISSION'));
  vm.close();
});

test('fail-closed default, distinct fs and network capabilities', async t => {
  const {server,origin} = await serverForTest(); t.after(() => server.close());
  const vm = new TenantHostedIoV1({tenantId:'isolated',allowedOrigins:[origin]});
  const read = vm.open_actor(1,1,{read:true});
  await assert.rejects(vm.read_text(read,'./empty'), rejectCode('E_FS_NOT_FOUND'));
  await assert.rejects(vm.write_text(read,'./secret','secret'),rejectCode('E_IO_PERMISSION'));
  await assert.rejects(vm.request_text(read,origin + '/data'),rejectCode('E_IO_PERMISSION'));
  const write = vm.open_actor(2,1,{write:true});
  await vm.write_text(write,'./secret','secret');
  await assert.rejects(vm.read_text(write,'./secret'),rejectCode('E_IO_PERMISSION'));
  assert.equal(await vm.read_text(read,'./secret'),'secret');
  await assert.rejects(vm.request_bytes(write,origin + '/data'),rejectCode('E_IO_PERMISSION'));
  vm.close();
});

test('tenant/actor tokens are opaque, scoped and generation fenced', async () => {
  const one = new TenantHostedIoV1({tenantId:'one'});
  const two = new TenantHostedIoV1({tenantId:'two'});
  const a = one.open_actor(7,1,{read:true,write:true});
  const b = two.open_actor(7,1,{read:true,write:true});
  await one.write_text(a,'./only','tenant 1');
  await assert.rejects(two.read_text(b,'./only'),rejectCode('E_FS_NOT_FOUND'));
  await assert.rejects(two.read_text(a,'./only'),rejectCode('E_IO_STALE'));
  await assert.rejects(one.read_text(Object.freeze({}),'./only'),rejectCode('E_IO_STALE'));
  const newer = one.open_actor(7,2,{read:true});
  await assert.rejects(one.read_text(a,'./only'),rejectCode('E_IO_STALE'));
  assert.equal(await one.read_text(newer,'./only'),'tenant 1');
  assert.throws(()=>one.open_actor(7,2,{read:true}),rejectCode('E_IO_STALE'));
  one.revoke_actor(7,2);
  await assert.rejects(one.read_text(newer,'./only'),rejectCode('E_IO_STALE'));
  one.close(); two.close();
});

test('path traversal, absolute paths and malformed text denied before any write',async()=>{
  const vm = new TenantHostedIoV1({tenantId:'path'});
  const actor = vm.open_actor(1,1,{read:true,write:true});
  for (const path of ['../x','./../x','/etc/passwd','C:/secret','./','a//b','a/./b',
    'a/../b','\\\\server\\share','evil\0txt','x'.repeat(300)]) {
    await assert.rejects(vm.write_text(actor,path,'data'),rejectCode('E_FS_PATH'),path);
    await assert.rejects(vm.read_text(actor,path),rejectCode('E_FS_PATH'),path);
  }
  await assert.rejects(vm.write_text(actor,'./good','\ud800'),rejectCode('E_INVALID_UTF8'));
  assert.equal(vm.file_count,0);
  vm.close();
});

test('overwrites do not partially mutate quota-limited files or leak bytes',async()=>{
  const vm = new TenantHostedIoV1({tenantId:'quota', maxFileBytes:10,maxTotalBytes:12,maxFiles:2});
  const actor=vm.open_actor(1,1,{read:true,write:true});
  await vm.write_text(actor,'one','1234567890');
  await assert.rejects(vm.write_text(actor,'one','abcdefghijk'),rejectCode('E_FS_LIMIT'));
  assert.equal(await vm.read_text(actor,'one'),'1234567890');
  await vm.write_text(actor,'two','ab');
  await assert.rejects(vm.write_text(actor,'three',''),rejectCode('E_FS_LIMIT'));
  await assert.rejects(vm.write_text(actor,'two','xyz'),rejectCode('E_FS_LIMIT'));
  assert.equal(await vm.read_text(actor,'two'),'ab');
  await vm.write_text(actor,'one','ok');
  await vm.write_text(actor,'two','xyz');
  assert.equal(vm.byte_count,5);
  vm.close();
  assert.equal(vm.file_count,0);
  assert.equal(vm.byte_count,0);
});

test('redirect, oversized body, invalid UTF-8 and noncanonical origin rejected',async t => {
  const {server, origin} = await serverForTest(); t.after(() => server.close());
  const vm = new TenantHostedIoV1({tenantId:'http', allowedOrigins:[origin],maxBodyBytes:16});
  const actor=vm.open_actor(1,1,{network:true});
  await assert.rejects(vm.request_text(actor,origin + '/redirect'),rejectCode('E_NET_RESPONSE'));
  await assert.rejects(vm.request_text(actor,origin + '/large'),rejectCode('E_NET_LIMIT'));
  await assert.rejects(vm.request_text(actor,origin + '/bad'),rejectCode('E_INVALID_UTF8'));
  await assert.rejects(vm.request_text(actor,origin + '/data#fragment'),rejectCode('E_NET_PERMISSION'));
  await assert.rejects(vm.request_text(actor,'http://evil@127.0.0.1:'+new URL(origin).port+'/data'),rejectCode('E_NET_PERMISSION'));
  vm.close();
});

test('cancellation and request quota settle without leaking authority',async t => {
  const {server,origin} = await serverForTest();t.after(() => server.close());
  const vm = new TenantHostedIoV1({tenantId:'cancel',allowedOrigins:[origin],timeoutMs:20,maxInflight:1});
  const actor = vm.open_actor(1,1,{network:true});
  const wait = vm.request_text(actor,origin + '/slow');
  await assert.rejects(vm.request_text(actor,origin + '/data'),rejectCode('E_NET_BUSY'));
  await assert.rejects(wait,rejectCode('E_IO_TIMEOUT'));
  const actor2 = vm.open_actor(1,2,{network:true});
  const wait2 = vm.request_text(actor2,origin + '/slow');
  vm.revoke_actor(1,2);
  await assert.rejects(wait2,rejectCode('E_IO_CANCELLED'));
  await assert.rejects(vm.request_text(actor2,origin + '/data'),rejectCode('E_IO_STALE'));
  vm.close();
});

test('invalid configuration cannot introduce ambient HTTP or excessive capacity',()=>{
  for(const opts of [
    {allowedOrigins:['https://example.com']},
    {allowedOrigins:['http://127.0.0.1/foo']},
    {maxBodyBytes:Infinity}, {maxInflight:0}, {maxFiles:0},
    {maxFileBytes:-1}
  ]){
    assert.throws(()=>new TenantHostedIoV1({tenantId:'test',...opts}),rejectCode('E_IO_CONFIG'));
  }
});


test('host transport ignoring AbortSignal remains charged against physical slot',async()=>{
  let complete;
  const origin='http://127.0.0.1:45988';
  const vm=new TenantHostedIoV1({tenantId:'delayed',allowedOrigins:[origin],maxInflight:1,
    fetchImpl:()=>new Promise(resolve=>{complete=resolve})});
  const first=vm.open_actor(1,1,{network:true});
  const pending=vm.request_bytes(first,origin+'/probe');
  vm.revoke_actor(1,1);
  await assert.rejects(pending,rejectCode('E_IO_CANCELLED'));
  const second=vm.open_actor(1,2,{network:true});
  await assert.rejects(vm.request_bytes(second,origin+'/probe'),rejectCode('E_NET_BUSY'));
  complete({url:origin+'/probe',status:200,type:'basic',body:null});
  await new Promise(resolve=>setImmediate(resolve));
  vm.close();
});

test('invalid or ungranted URL rejects before touching transport',async()=>{
  let calls=0;
  const vm=new TenantHostedIoV1({tenantId:'deny',allowedOrigins:['http://127.0.0.1:45989'],
    fetchImpl:()=>{calls++;throw Error('must not reach host transport')}});
  const actor=vm.open_actor(1,1,{network:true});
  for(const url of ['file:///etc/passwd','https://example.com/','http://127.0.0.1:7/x',
    'http://evil@127.0.0.1:45989/x','http://127.0.0.1:45989/x#frag']) {
    await assert.rejects(vm.request_bytes(actor,url),HostIoError);
  }
  assert.equal(calls,0);
  vm.close();
});


test('malformed host response body errors are sanitized and empty 204 is supported',async()=>{
  const origin='http://127.0.0.1:45990';
  const bad=new TenantHostedIoV1({tenantId:'bad',allowedOrigins:[origin],
    fetchImpl:async url=>({status:200,url,type:'basic',body:{getReader:()=>({
      read:async()=>{throw Error('sensitive adapter details')},releaseLock:()=>{}
    })}})});
  const badActor=bad.open_actor(1,1,{network:true});
  await assert.rejects(bad.request_text(badActor,origin+'/x'),rejectCode('E_NET_TRANSPORT'));
  bad.close();
  const empty=new TenantHostedIoV1({tenantId:'empty',allowedOrigins:[origin],
    fetchImpl:async url=>({status:204,url,type:'basic',body:null})});
  const actor=empty.open_actor(1,1,{network:true});
  assert.deepEqual(await empty.request_text(actor,origin+'/empty'),{status:204,text:''});
  empty.close();
});
