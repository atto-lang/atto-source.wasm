// Host-only FS implementation tests. These do NOT link an Atto guest.
import test from 'node:test';
import assert from 'node:assert/strict';
import {TenantHostedIoV1, HostIoError, FsError, FsErrorKind, fs_error_kind, FsPath, FsPathBuf,
  path_join, path_parent, path_file_name, path_extension, path_normalize}
  from '../runtime/hosted-io-v1.mjs';

const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const rejects = code => error => error instanceof HostIoError && error.code===code;
const make = (opts={})=>new TenantHostedIoV1({tenantId:'fs-api', ...opts});
const adminGrants={read:true,write:true,directories:true,remove:true,recursive:true};

test('paths are canonical and the lexical normalization never hides traversal',()=>{
  assert.equal(path_normalize('a//./b').toString(),'a/b');
  assert.equal(path_join('a','b').toString(),'a/b');
  assert.equal(path_parent('a/b').toString(),'a');
  assert.equal(path_file_name('a/x.txt'),'x.txt');
  assert.equal(path_extension('a/x.txt'),'txt');
  assert.equal(new FsPath('a/.hidden').extension(),null);
  const buf=new FsPathBuf('a/b');
  assert.equal(buf.pop(),'b');
  assert.equal(buf.to_path().toString(),'a');
  assert.equal(buf.pop(),'a');
  assert.equal(buf.to_path().toString(),'.');
  assert.equal(buf.pop(),null);
  buf.push('again');
  assert.equal(buf.toString(),'again');
  for(const p of ['../escape','a/../../escape','/rooted','a/evil\\name','C:/x']) {
    assert.throws(()=>new FsPath(p),rejects('E_FS_PATH'));
  }
});

test('bytes write/read/append/copy/rename never alias or touch disk',async()=>{
  const fs=make(),actor=fs.open_actor(1,1,adminGrants);
  const input=encode('abc');
  await fs.write_file(actor,'one',input);
  input[0]=90;
  const output=await fs.read_file(actor,'one');
  assert.equal(decode(output),'abc');
  output[0]=88;
  assert.equal(decode(await fs.read_file(actor,'one')),'abc');
  await fs.append_file(actor,'one',encode('!'));
  await fs.copy_file(actor,'one','two');
  await fs.rename(actor,'two','three');
  assert.equal(decode(await fs.read_file(actor,'three')),'abc!');
  assert.equal(await fs.exists(actor,'two'),false);
  assert.deepEqual(await fs.metadata(actor,'three'),
    {is_file:true,is_dir:false,size:4});
  assert.equal(await fs.file_size(actor,'three'),4);
  await fs.remove_file(actor,'three');
  await assert.rejects(fs.read_file(actor,'three'),rejects('E_FS_NOT_FOUND'));
  fs.close();
});

test('directories have sorted listings, explicit creation and separate delete caps',async()=>{
  const fs=make(),actor=fs.open_actor(1,1,adminGrants);
  assert.deepEqual(await fs.read_dir(actor,'.'),[]);
  await assert.rejects(fs.create_dir(actor,'tree/leaf'),rejects('E_FS_NOT_FOUND'));
  await fs.create_dir_all(actor,'tree/leaf');
  await fs.write_file(actor,'tree/leaf/z',encode('z'));
  await fs.write_file(actor,'tree/leaf/a',encode('a'));
  assert.deepEqual((await fs.read_dir(actor,'tree/leaf')).map(x=>x.name),['a','z']);
  assert.deepEqual((await fs.read_dir(actor,'./')).map(x=>x.name),['tree']);
  assert.equal(await fs.is_dir(actor,'tree/leaf'),true);
  assert.equal(await fs.is_file(actor,'tree/leaf'),false);
  await assert.rejects(fs.remove_dir(actor,'tree/leaf'),rejects('E_FS_NOT_EMPTY'));
  await assert.rejects(fs.remove_dir_all(actor,'./'),rejects('E_FS_PATH'));
  await fs.rename(actor,'tree/leaf','tree/moved');
  assert.equal(decode(await fs.read_file(actor,'tree/moved/a')),'a');
  await fs.remove_dir_all(actor,'tree/moved');
  assert.equal(fs.file_count,0);
  await fs.remove_dir(actor,'tree');
  assert.equal(fs.dir_count,0);
  fs.close();
});

test('distinct READ WRITE directory delete and recursive rights are enforced',async()=>{
  const fs=make();
  const owner=fs.open_actor(1,1,adminGrants);
  await fs.create_dir(owner,'folder');
  await fs.write_file(owner,'folder/secret',encode('secret'));
  const reader=fs.open_actor(2,1,{read:true});
  const writer=fs.open_actor(3,1,{write:true});
  const dirWriter=fs.open_actor(4,1,{write:true,directories:true});
  await assert.rejects(fs.write_file(reader,'folder/secret',encode('x')),rejects('E_IO_PERMISSION'));
  await assert.rejects(fs.read_file(writer,'folder/secret'),rejects('E_IO_PERMISSION'));
  await assert.rejects(fs.remove_file(writer,'folder/secret'),rejects('E_IO_PERMISSION'));
  await assert.rejects(fs.create_dir(writer,'folder/new'),rejects('E_IO_PERMISSION'));
  await assert.rejects(fs.remove_dir_all(dirWriter,'folder'),rejects('E_IO_PERMISSION'));
  assert.equal(await fs.exists(reader,'folder/secret'),true);
  assert.equal(decode(await fs.read_file(owner,'folder/secret')),'secret');
  fs.close();
});

test('open options, cursor reads, append, flush and idempotent close',async()=>{
  const fs=make(),actor=fs.open_actor(1,1,adminGrants);
  await assert.rejects(fs.open(actor,'file',{}),rejects('E_FS_OPTIONS'));
  await assert.rejects(fs.open(actor,'file',{read:true,truncate:true}),rejects('E_FS_OPTIONS'));
  const created=await fs.open(actor,'file',{write:true,create_new:true});
  assert.equal(await created.write(encode('hello')),5);
  await created.flush();
  await created.close();await created.close();
  const reader=await fs.open(actor,'file',{read:true});
  assert.equal(decode(await reader.read(2)),'he');
  assert.equal(decode(await reader.read(8)),'llo');
  assert.equal((await reader.read(2)).length,0);
  await reader.close();
  await assert.rejects(reader.read(1),rejects('E_FS_CLOSED'));
  const append=await fs.open(actor,'file',{append:true});
  await append.write(encode('!'));await append.close();
  assert.equal(decode(await fs.read_file(actor,'file')),'hello!');
  await assert.rejects(fs.open(actor,'file',{write:true,create_new:true}),rejects('E_FS_EXISTS'));
  fs.close();
});

test('read_stream/write_stream are bounded and close on EOF',async()=>{
  const fs=make(),actor=fs.open_actor(1,1,adminGrants);
  const writer=await fs.write_stream(actor,'stream');
  await writer.write_chunk(encode('abcdef'));
  await writer.flush();await writer.close();
  const reader=await fs.read_stream(actor,'stream',2);
  const all=[];
  for(let part;(part=await reader.read_chunk())!==null;) all.push(decode(part));
  assert.deepEqual(all,['ab','cd','ef']);
  await reader.close();
  await assert.rejects(reader.read_chunk(),rejects('E_FS_CLOSED'));
  fs.close();
});

test('quotas fail without mutating previous bytes, dirs or handles',async()=>{
  const fs=make({maxFileBytes:4,maxTotalBytes:5,maxFiles:1,maxDirs:1,maxHandles:1});
  const actor=fs.open_actor(1,1,adminGrants);
  await fs.create_dir(actor,'one');
  await assert.rejects(fs.create_dir(actor,'two'),rejects('E_FS_LIMIT'));
  await fs.write_file(actor,'one/a',encode('abcd'));
  await assert.rejects(fs.append_file(actor,'one/a',encode('e')),rejects('E_FS_LIMIT'));
  await assert.rejects(fs.write_file(actor,'one/b',encode('')),rejects('E_FS_LIMIT'));
  const file=await fs.open(actor,'one/a',{read:true});
  await assert.rejects(fs.open(actor,'one/a',{read:true}),rejects('E_FS_LIMIT'));
  assert.equal(decode(await fs.read_file(actor,'one/a')),'abcd');
  assert.equal(fs.dir_count,1);assert.equal(fs.file_count,1);assert.equal(fs.byte_count,4);
  await file.close();fs.close();
});

test('actor revocation fences leaked handles and does not affect other tenants',async()=>{
  const one=make(),two=make();
  const a=one.open_actor(1,1,adminGrants),b=two.open_actor(1,1,adminGrants);
  await one.write_file(a,'secret',encode('one'));
  const file=await one.open(a,'secret',{read:true});
  assert.equal(await two.exists(b,'secret'),false);
  one.revoke_actor(1,1);
  await assert.rejects(file.read(2),rejects('E_IO_STALE'));
  const next=one.open_actor(1,2,{read:true});
  assert.equal(decode(await one.read_file(next,'secret')),'one');
  await assert.rejects(one.read_file(a,'secret'),rejects('E_IO_STALE'));
  one.close();two.close();
});

test('filesystem errors expose stable FsErrorKind without leaking host paths',async()=>{
  const fs=make(),actor=fs.open_actor(1,1,{read:true});
  await assert.rejects(fs.read_file(actor,'absent'),error=>
    error instanceof FsError && error.kind===FsErrorKind.not_found &&
    error.code==='E_FS_NOT_FOUND' && !error.message.includes('/mnt/'));
  await assert.rejects(fs.read_file(actor,'../escape'),error=>
    error instanceof FsError && error.kind===FsErrorKind.invalid_path);
  fs.close();
});


test('host VFS rejects control, bidi, oversize paths before state mutation', async()=>{
  const fs=make(),actor=fs.open_actor(1,1,adminGrants);
  for(const path of ['a\nb','a\u0085b','a\u202eb','a\u2066b','x'.repeat(257)]) {
    assert.throws(()=>new FsPath(path),rejects('E_FS_PATH'));
    await assert.rejects(fs.write_file(actor,path,encode('a')),rejects('E_FS_PATH'));
  }
  assert.equal(fs.file_count,0);
  fs.close();
});

test('renamed files invalidate old handles and preserve bytes', async()=>{
  const fs=make(),actor=fs.open_actor(1,1,adminGrants);
  await fs.write_file(actor,'a',encode('payload'));
  const reader=await fs.open(actor,'a',{read:true});
  await fs.rename(actor,'a','b');
  await assert.rejects(reader.read(1),rejects('E_FS_CLOSED'));
  assert.equal(decode(await fs.read_file(actor,'b')),'payload');
  assert.equal(fs.handle_count,0);
  fs.close();
});

test('tenant root is a first-class lexical Path but not a mutable file',async()=>{
  const root=new FsPath('.');
  assert.equal(root.toString(),'.');
  assert.equal(root.parent(),null);
  assert.equal(root.file_name(),null);
  assert.equal(root.extension(),null);
  assert.equal(root.join('alpha').toString(),'alpha');
  assert.equal(path_parent('alpha').toString(),'.');
  const buf=new FsPathBuf('.');
  buf.push('alpha');assert.equal(buf.pop(),'alpha');
  assert.equal(buf.to_path().toString(),'.');
  const fs=make(),actor=fs.open_actor(1,1,adminGrants);
  assert.equal((await fs.metadata(actor,root)).is_dir,true);
  assert.equal((await fs.read_dir(actor,root)).length,0);
  await assert.rejects(fs.remove_dir_all(actor,root),rejects('E_FS_PATH'));
  await assert.rejects(fs.write_file(actor,root,encode('bad')),rejects('E_FS_PATH'));
  fs.close();
});

test('FsErrorKind translates host I/O permission, stale and invalid UTF-8',async()=>{
  const fs=make();
  const reader=fs.open_actor(1,1,{read:true});
  const writer=fs.open_actor(2,1,{write:true});
  await assert.rejects(fs.read_file(writer,'secret'),error=>
    fs_error_kind(error)===FsErrorKind.permission_denied);
  await assert.rejects(fs.read_file(reader,'secret'),error=>
    fs_error_kind(error)===FsErrorKind.not_found);
  fs.revoke_actor(1,1);
  await assert.rejects(fs.read_file(reader,'secret'),error=>
    fs_error_kind(error)===FsErrorKind.closed);
  assert.equal(fs_error_kind(new Error('unexpected')),FsErrorKind.io_error);
  fs.close();
});
