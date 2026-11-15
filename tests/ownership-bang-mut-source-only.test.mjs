// Source-only fixture identity and mutation rejection. NOT actual wasm32 guest
// execution, not ownership-checker success, and not an LLVM build attestation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const expected = 'pub fnc main(): int { val int item = 42; return borrow! mut item; }\n';
const reviewedBlob = '93ef3e5cdc39e9ed6d974737bcc713afc98cefc1';
const gitBlob = bytes => createHash('sha1')
  .update(Buffer.from('blob '+bytes.length+'\0','ascii'))
  .update(bytes).digest('hex');

test('canonical borrow! mut .atto spelling remains an exact source candidate',async()=>{
  const bytes=await readFile(new URL(
    './fixtures/ownership-bang-v1/borrow-mut-source-only.atto',import.meta.url));
  assert.ok(bytes.length < 4096,'bounded source');
  assert.equal(bytes.toString('utf8'),expected,'canonical source changed');
  assert.equal(gitBlob(bytes),reviewedBlob,'reviewed fixture blob drifted');
  assert.match(expected,/\bborrow! mut item;/);
  assert.doesNotMatch(expected,/\bmut borrow!\b/);
});
