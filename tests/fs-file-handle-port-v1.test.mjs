// Host-owned candidate for Atto fs.File guest-handle lowering.
// It does NOT execute an Atto guest or exercise actual Wasm imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {TenantHostedIoV1, HostIoError} from '../runtime/hosted-io-v1.mjs';
import {ActorFileHandlePortV1, FILE_HANDLE_PORT_ABI_V1}
  from '../runtime/fs-file-handle-port-v1.mjs';

const enc=s=>new TextEncoder().encode(s);
const dec=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);
const codeIs=code=>error=>error instanceof HostIoError && error.code===code;
const grants={read:true,write:true,directories:true,remove:true};
const mk=(opts={})=>new TenantHostedIoV1({
  tenantId:'file-port-test',fetchImpl:async()=>{throw Error('unexpected fetch')},
  ...opts
});

test('v1 metadata explicitly reports unlinked guest import',()=>{
  assert.equal(FILE_HANDLE_PORT_ABI_V1.version,1);
  assert.equal(FILE_HANDLE_PORT_ABI_V1.guest_import_linked,false);
  assert.ok(FILE_HANDLE_PORT_ABI_V1.operations.includes('read_text'));
});

test('file instance uses only numeric guest handle, shared seek cursor, explicit close',async()=>{
  const vfs=mk(),owner=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,owner);
  const id=await port.open('hello',{read:true,write:true,create:true,truncate:true});
  assert.equal(typeof id,'number');
  await port.write_text(id,'hello');
  assert.equal(await port.seek(id,0),0);
  assert.equal(await port.read_text(id),'hello');
  assert.equal(await port.read_text(id),'');
  await port.seek(id,0);
  assert.equal(dec(await port.read_file(id)),'hello');
  await port.flush(id);
  assert.equal(vfs.handle_count,1);
  await port.close(id);
  assert.equal(vfs.handle_count,0);
  await assert.rejects(port.read_text(id),codeIs('E_FS_CLOSED'));
  vfs.close();
});

test('byte writes, partial reads and overwrite use same file cursor',async()=>{
  const vfs=mk(),token=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,token);
  const id=await port.open('data',{read:true,write:true,create:true});
  assert.equal(await port.write(id,enc('abc')),3);
  await port.seek(id,1);
  assert.equal(dec(await port.read(id,2)),'bc');
  await port.seek(id,1);
  await port.write_file(id,enc('XY'));
  await port.seek(id,0);
  assert.equal(await port.read_text(id),'aXY');
  await port.close(id);vfs.close();
});

test('cross-actor and cross-tenant numeric ID guesses cannot reach foreign files',async()=>{
  const a=mk(),b=mk();
  const t1=a.open_actor(1,1,grants),t2=a.open_actor(2,1,{read:true});
  const t3=b.open_actor(1,1,grants);
  const owner=new ActorFileHandlePortV1(a,t1);
  const stranger=new ActorFileHandlePortV1(a,t2);
  const foreign=new ActorFileHandlePortV1(b,t3);
  const id=await owner.open('secret',{write:true,create:true});
  await owner.write_text(id,'hidden');
  await assert.rejects(stranger.read_text(id),codeIs('E_FS_HANDLE'));
  await assert.rejects(foreign.read_file(id),codeIs('E_FS_HANDLE'));
  assert.equal(await a.read_text(t2,'secret'),'hidden'); // READ grant, not a foreign handle.
  await owner.close(id);await Promise.all([owner.close_all(),stranger.close_all(),foreign.close_all()]);
  a.close();b.close();
});

test('read-only and write-only handle modes are enforced at privileged VFS',async()=>{
  const vfs=mk(),token=vfs.open_actor(1,1,grants);
  await vfs.write_file(token,'f',enc('abc'));
  const port=new ActorFileHandlePortV1(vfs,token);
  const reader=await port.open('f',{read:true});
  await assert.rejects(port.write_text(reader,'!'),codeIs('E_IO_PERMISSION'));
  const writer=await port.open('f',{write:true});
  await assert.rejects(port.read_text(writer),codeIs('E_IO_PERMISSION'));
  assert.equal(await port.read_text(reader),'abc');
  await port.close(reader);await port.close(writer);vfs.close();
});

test('revoked actor generation fences every numeric File operation',async()=>{
  const vfs=mk(),token=vfs.open_actor(1,7,grants);
  const port=new ActorFileHandlePortV1(vfs,token);
  const id=await port.open('x',{read:true,write:true,create:true});
  await port.write_text(id,'before');
  vfs.revoke_actor(1,7);
  await assert.rejects(port.read_text(id),codeIs('E_IO_STALE'));
  await assert.rejects(port.seek(id,0),codeIs('E_IO_STALE'));
  await assert.rejects(port.close(id),codeIs('E_IO_STALE'));
  await port.close_all();vfs.close();
});

test('failed opens never create valid handles; IDs are never reused',async()=>{
  const vfs=mk(),token=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,token,{maxOpen:1,maxIssued:3});
  await assert.rejects(port.open('missing',{read:true}),codeIs('E_FS_NOT_FOUND'));
  await assert.rejects(port.read_text(1),codeIs('E_FS_HANDLE'));
  const id=await port.open('ok',{read:true,write:true,create:true});
  assert.equal(id,2);
  await port.close(id);
  await assert.rejects(port.read_text(id),codeIs('E_FS_CLOSED'));
  await assert.rejects(port.read_text(3),codeIs('E_FS_HANDLE'));
  const id3=await port.open('ok',{read:true});
  assert.equal(id3,3);
  await port.close(id3);
  await assert.rejects(port.open('ok',{read:true}),codeIs('E_FS_LIMIT'));
  vfs.close();
});

test('concurrent open reservations cannot bypass maxOpen quota',async()=>{
  const vfs=mk(),token=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,token,{maxOpen:1,maxIssued:10});
  const pending=port.open('first',{read:true,write:true,create:true});
  await assert.rejects(port.open('second',{write:true,create:true}),codeIs('E_FS_LIMIT'));
  const id=await pending;
  assert.equal(port.open_handle_count,1);
  assert.equal(vfs.file_count,1);
  await port.close(id);vfs.close();
});

test('quota denial leaves prior bytes and cursor intact',async()=>{
  const vfs=mk({maxFileBytes:5,maxTotalBytes:5});
  const token=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,token);
  const id=await port.open('q',{read:true,write:true,create:true});
  await port.write_text(id,'abc');
  await assert.rejects(port.write_text(id,'123456'),codeIs('E_FS_LIMIT'));
  await port.seek(id,0);
  assert.equal(await port.read_text(id),'abc');
  await port.seek(id,3);
  await assert.rejects(port.write_file(id,enc('xyz')),codeIs('E_FS_LIMIT'));
  await port.seek(id,0);
  assert.equal(await port.read_text(id),'abc');
  await port.close(id);vfs.close();
});

test('close_all handles racing open without leaking host handles',async()=>{
  const vfs=mk(),token=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,token);
  const pending=port.open('late',{read:true,write:true,create:true});
  await port.close_all();
  await assert.rejects(pending,codeIs('E_FS_CLOSED'));
  assert.equal(port.open_handle_count,0);
  assert.equal(vfs.handle_count,0);
  await assert.rejects(port.open('other',{write:true,create:true}),codeIs('E_FS_CLOSED'));
  await port.close_all();
  vfs.close();
});

test('port constructor and forged handle IDs fail closed',async()=>{
  const vfs=mk(),ticket=vfs.open_actor(1,1,grants);
  assert.throws(()=>new ActorFileHandlePortV1(vfs,ticket,{maxOpen:2,maxIssued:1}),codeIs('E_FS_OPTIONS'));
  assert.throws(()=>new ActorFileHandlePortV1(vfs,ticket,{maxOpen:1,unknown:true}),codeIs('E_FS_OPTIONS'));
  assert.throws(()=>new ActorFileHandlePortV1(vfs,null),codeIs('E_FS_OPTIONS'));
  const port=new ActorFileHandlePortV1(vfs,ticket);
  for(const id of [0,-1,1,1.5,'1',null,{},Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(port.read_text(id),codeIs('E_FS_HANDLE'));
  }
  const classified=await port.read_text(1).catch(error=>error);
  assert.equal(classified.kind,'invalid_handle');
  vfs.close();
});

test('append mode writes at EOF even after seek and does not truncate',async()=>{
  const vfs=mk(),token=vfs.open_actor(1,1,grants);
  await vfs.write_text(token,'append','a');
  const port=new ActorFileHandlePortV1(vfs,token);
  const id=await port.open('append',{append:true});
  await port.write_text(id,'b');
  await port.seek(id,0);
  await port.write_text(id,'c');
  assert.equal(await vfs.read_text(token,'append'),'abc');
  await port.close(id);vfs.close();
});


test('port rejects overlapping reads and seeks on one File with E_FS_BUSY',async()=>{
  const vfs=mk(),ticket=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,ticket);
  const id=await port.open('race',{read:true,write:true,create:true});
  await port.write_text(id,'abcd');await port.seek(id,0);
  const first=port.read_text(id);
  const overlap=assert.rejects(port.seek(id,0),codeIs('E_FS_BUSY'));
  const closeWhileBusy=assert.rejects(port.close(id),codeIs('E_FS_BUSY'));
  await Promise.all([overlap,closeWhileBusy]);
  assert.equal(await first,'abcd');
  await port.close(id);vfs.close();
});

test('structured close_all rejects late success and cleans all handles',async()=>{
  const vfs=mk(),ticket=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,ticket);
  const id=await port.open('r',{read:true,write:true,create:true});
  const inflight=port.write_text(id,'done');
  const closeOne=port.close_all();
  const closeTwo=port.close_all();
  await assert.rejects(inflight,codeIs('E_FS_CLOSED'));
  await Promise.all([closeOne,closeTwo]);
  assert.equal(vfs.handle_count,0);
  assert.equal(port.open_handle_count,0);
  await assert.rejects(port.read_text(id),codeIs('E_FS_CLOSED'));
  // A completed host write may have committed before cancellation: no
  // promise of rollback and no automatic retry on uncertain outcome.
  assert.equal(await vfs.read_text(ticket,'r'),'done');
  vfs.close();
});

test('port denies overlapping write_file/read_file, preserves cursor and data',async()=>{
  const vfs=mk(),ticket=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,ticket);
  const id=await port.open('x',{read:true,write:true,create:true});
  const write=port.write_file(id,enc('123'));
  await assert.rejects(port.read_file(id),codeIs('E_FS_BUSY'));
  await write;await port.seek(id,0);
  const read=port.read_file(id);
  await assert.rejects(port.write_file(id,enc('abc')),codeIs('E_FS_BUSY'));
  assert.equal(dec(await read),'123');
  await port.close(id);vfs.close();
});

test('port close fences an overlapping flush and prevents handle reuse',async()=>{
  const vfs=mk(),ticket=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,ticket);
  const id=await port.open('x',{read:true,write:true,create:true});
  const flush=port.flush(id);
  await assert.rejects(port.close(id),codeIs('E_FS_BUSY'));
  await flush;
  await port.close(id);
  await assert.rejects(port.flush(id),codeIs('E_FS_CLOSED'));
  const again=await port.open('x',{read:true});
  assert.ok(again>id);
  await port.close(again);vfs.close();
});

test('File.close is idempotent for issued IDs but cannot accept forged IDs',async()=>{
  const vfs=mk(),ticket=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,ticket);
  const id=await port.open('cleanup',{read:true,write:true,create:true});
  await port.close(id);
  await port.close(id);
  assert.equal(vfs.handle_count,0);
  await assert.rejects(port.close(id+1),codeIs('E_FS_HANDLE'));
  await assert.rejects(port.read_text(id),codeIs('E_FS_CLOSED'));
  await port.close_all();vfs.close();
});

test('revocation during pending read never returns a stale success',async()=>{
  const vfs=mk(),ticket=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,ticket);
  const id=await port.open('f',{read:true,write:true,create:true});
  await port.write_text(id,'secret');
  await port.seek(id,0);
  const pending=port.read_text(id);
  vfs.revoke_actor(1,1);
  await assert.rejects(pending,codeIs('E_IO_STALE'));
  assert.equal(vfs.handle_count,0);
  await port.close_all();
  vfs.close();
});

test('revocation during pending open retires host object and never issues handle',async()=>{
  const vfs=mk(),ticket=vfs.open_actor(1,1,grants);
  const port=new ActorFileHandlePortV1(vfs,ticket);
  const pending=port.open('late',{read:true,write:true,create:true});
  vfs.revoke_actor(1,1);
  await assert.rejects(pending,codeIs('E_IO_STALE'));
  assert.equal(port.open_handle_count,0);
  assert.equal(vfs.handle_count,0);
  await assert.rejects(port.read_text(1),codeIs('E_FS_HANDLE'));
  await port.close_all();vfs.close();
});
