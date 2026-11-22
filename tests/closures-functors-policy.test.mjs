import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CONTRACT, gitBlob, sha256, verifyPins, verifyAndRun} from
  '../scripts/verify-closures-functors-wasm.mjs';

const site = readFileSync(new URL('../fixtures/closures-functors.atto', import.meta.url));
const fake = Buffer.from([0,97,115,109,1,0,0,0]);
const valid = () => ({
  sourceHead:CONTRACT.compilerHead, sourceTree:CONTRACT.compilerTree,
  sampleBytes:site, candidateBytes:fake, candidateSha256:sha256(fake)
});
test('exact site Git blob and source sample', () => {
  assert.equal(gitBlob(site), CONTRACT.siteExampleBlob);
  assert.match(site.toString(), /multiply\(3\) \+ plus_seven\.call\(35\)/);
  assert.equal(verifyPins(valid()), true);
});
test('tampered site source is rejected', () => {
  assert.throws(()=>verifyPins({...valid(), sampleBytes:Buffer.concat([site,Buffer.from('x')])}),
    /not exact PR #126/);
});
test('invalid or incorrect compiler digest is rejected', () => {
  assert.throws(()=>verifyPins({...valid(), candidateSha256:''}), /missing explicit/);
  assert.throws(()=>verifyPins({...valid(), candidateSha256:'0'.repeat(64)}), /digest mismatch/);
  assert.throws(()=>verifyPins({...valid(), candidateBytes:Buffer.alloc(1024*1024+1)}),
    /safe artifact size bounds/);
});
test('source head and tree are exact and immutable', () => {
  assert.throws(()=>verifyPins({...valid(), sourceHead:'f'.repeat(40)}), /head differs/);
  assert.throws(()=>verifyPins({...valid(), sourceTree:'0'.repeat(40)}), /tree differs/);
});
test('synthetic module is not treated as a real compiler', () => {
  assert.throws(()=>verifyAndRun({
    compilerBytes:fake, sampleBytes:site, candidateSha256:sha256(fake),
    sourceHead:CONTRACT.compilerHead, sourceTree:CONTRACT.compilerTree
  }), /compiler memory export required/);
});
test('contract is an actual guest ABI v2 profile with expected 84', () => {
  assert.equal(CONTRACT.compilerAbi, 2);
  assert.equal(CONTRACT.guestAbi, 'atto.browser.guest.v2');
  assert.equal(CONTRACT.expectedMain, 84n);
});
