// Scalar admission checks only. NOT an Atto compiler borrow checker or guest test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(path.join(root,p),'utf8');
const policy=JSON.parse(read('contracts/core-borrow-preflight-v1.json'));
const paths=['src/main/resources/dev/oreslang/core/borrow_admission.atto',
  'stdlib/core/borrow_admission.atto'];
const sourcePath=paths.find(p=>existsSync(path.join(root,p)));
const source=sourcePath?read(sourcePath):'';
const valid=(readers,writer,live)=>Number.isInteger(readers)&&readers>=0&&
  readers<=65535&&!(writer&&readers!==0)&&
  (live||(readers===0&&!writer));
test('core source has explicit bounded loan preflight but no authority minted',()=>{
  assert.ok(sourcePath,'missing backend-owned core/borrow_admission.atto');
  assert.match(source,/define module borrow_admission as/);
  for(const fn of ['valid_state','may_read','may_write','quiescent_owner',
    'may_finish_read','may_finish_write','quiescent_boundary']) {
    assert.ok(source.includes('pub fnc '+fn+'('),fn+' missing');
  }
  assert.ok(source.includes('readers > 65535'));
  assert.ok(source.includes('writer && readers != 0'));
  assert.ok(source.includes('!owner_live && (readers != 0 || writer)'));
  assert.match(source,/NOT a compiler borrow checker/);
  assert.doesNotMatch(source.replace(/\/\/[^\n]*/g,''),/\bjava:|HostInterop|stdio\.|process\.|ffi\./);
});
test('13 loan-state reference vectors are fail-closed; no guest PASS claimed',()=>{
  assert.equal(policy.schema,'atto.core.borrow-admission-source-v1');
  assert.equal(policy.status,'SOURCE_ONLY_REFERENCE_NOT_COMPILER_LOAN_PROOF');
  assert.equal(policy.guest_compiler,'NOT_EXECUTED');
  assert.equal(policy.native_aot,'NOT_EXECUTED');
  assert.equal(policy.vectors.length,13);
  for(const x of policy.vectors) {
    const v=valid(x.readers,x.writer,x.owner_live);
    const observed={
      valid:v,
      may_read:v&&x.owner_live&&!x.writer&&x.readers<65535,
      may_write:v&&x.owner_live&&!x.writer&&x.readers===0,
      quiescent_owner:v&&x.owner_live&&x.readers===0&&!x.writer,
      may_finish_read:v&&x.owner_live&&x.readers>0&&!x.writer,
      may_finish_write:v&&x.owner_live&&x.readers===0&&x.writer,
      quiescent_boundary:v&&x.owner_live&&x.readers===0&&!x.writer
    };
    for(const [key,got] of Object.entries(observed))
      assert.equal(got,x[key],JSON.stringify({x,key}));
  }
});
