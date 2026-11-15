// Source-only fixture identity and mutation rejection. NOT actual wasm32 guest
// execution, not ownership-checker success, and not an LLVM build attestation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open} from 'node:fs/promises';

const expected = 'pub fnc main(): int { val int item = 42; return borrow! mut item; }\n';
const reviewedBlob = '93ef3e5cdc39e9ed6d974737bcc713afc98cefc1';
const gitBlob = bytes => createHash('sha1')
  .update(Buffer.from('blob '+bytes.length+'\0','ascii'))
  .update(bytes).digest('hex');

// A hash match alone is not a source-tree provenance check: a symlink to an
// identical external file must not become a trusted compiler input. Limit the
// open descriptor's read size even if a fixture changes after stat.
async function readPinnedFixture() {
  const directory = new URL('./fixtures/ownership-bang-v1/',import.meta.url);
  const fixture = new URL('./fixtures/ownership-bang-v1/borrow-mut-source-only.atto',import.meta.url);
  const parent = await lstat(directory);
  const file = await lstat(fixture);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink(),'fixture directory must be a real directory');
  assert.ok(file.isFile() && !file.isSymbolicLink(),'fixture must be a regular file');
  assert.ok(file.size > 0 && file.size <= 4096,'bounded source before open');
  const handle = await open(fixture, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const verified = await handle.stat();
    assert.ok(verified.isFile() && verified.size > 0 && verified.size <= 4096,'bounded opened fixture');
    const buffer=Buffer.alloc(4097);
    let used=0;
    while(used<buffer.length){
      const {bytesRead}=await handle.read(buffer,used,buffer.length-used,used);
      if(bytesRead===0)break;
      used+=bytesRead;
    }
    assert.ok(used>0 && used<=4096,'source grew beyond fixture budget');
    return buffer.subarray(0,used);
  } finally {
    await handle.close();
  }
}

test('canonical borrow! mut .atto spelling remains an exact source candidate',async()=>{
  const bytes=await readPinnedFixture();
  assert.equal(bytes.toString('utf8'),expected,'canonical source changed');
  assert.equal(gitBlob(bytes),reviewedBlob,'reviewed fixture blob drifted');
  assert.match(expected,/\bborrow! mut item;/);
  assert.doesNotMatch(expected,/\bmut borrow!\b/);
});
