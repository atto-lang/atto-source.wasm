import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {readBoundedRegularFile} from './compile-ores.mjs';

// Direct native compiler denial, independent of bridge preflight. Keep the
// staged binary in the caller's private mkdtemp workspace; never mutate the
// compiler provided by the caller. Neither a crash nor a bridge exception
// qualifies as language rejection.
export async function assertNativeRemovedPercent({compiler,compilerSha256,source,work}) {
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const {bytes}=await readBoundedRegularFile(compiler,256*1024*1024,'bounded compiler snapshot');
  assert.equal(hash(bytes),compilerSha256);
  const staged=join(work,'percent-compiler-exact');
  try {await writeFile(staged,bytes,{flag:'wx',mode:0o500});}
  catch(e){if(e.code!=='EEXIST')throw e;}
  assert.equal(hash(await readFile(staged)),compilerSha256);
  const input=await readFile(source);
  const r=spawnSync(staged,['--tree-shake','--tree-shake-root=main','--target=wasm32',source],
    {encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
  assert.ifError(r.error);
  assert.equal(r.signal,null);
  assert.equal(r.status,1);
  assert.equal(r.stdout,'','rejected source emitted IR');
  assert.match(r.stderr,/oreslang-llvmc:.*(?:'%' is reserved|noncanonical '%' source operator)/);
  assert.doesNotMatch(r.stderr,/segmentation fault|internal compiler error|LLVM ERROR|core dumped/i);
  assert.deepEqual(await readFile(source),input);
  assert.equal(hash(await readFile(staged)),compilerSha256);
}
