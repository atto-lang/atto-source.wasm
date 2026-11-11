import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const manifest=JSON.parse(readFileSync(new URL('../contracts/value-block-range-v0/cases.json',import.meta.url),'utf8'));
test('canonical value-block/range contract is present but not marked executable',()=>{
  assert.equal(manifest.schema,'attolang.value-block-range.v0');
  assert.equal(manifest.status,'PROPOSED_NOT_COMPILER_VERIFIED');
  assert.equal(manifest.cases.length,17);
  assert.equal(manifest.requires_compiled_guest_for_pass,true);
  assert.equal(new Set(manifest.cases.map(x=>x.id)).size,17);
});
test('harness rejects missing actual compiler and guest commands',()=>{
  const env={...process.env};
  for(const key of Object.keys(env)) if(key.startsWith('ATTO_VBR_')) delete env[key];
  const result=spawnSync(process.execPath,
    [new URL('../scripts/run-value-block-range-v0.mjs',import.meta.url).pathname],
    {encoding:'utf8',env,timeout:10000});
  assert.equal(result.status,1,'missing compiler must cause nonzero exit');
  const report=JSON.parse(result.stdout);
  assert.equal(report.evidence_class,'UNVERIFIED_LOCAL_COMPILER_OBSERVATIONS');
  assert.equal(report.passed,0);
  assert.ok(report.failed>0);
});
test('harness rejects nonexistent guest compiler instead of accepting model evidence',()=>{
  const env={...process.env};
  for(const key of Object.keys(env)) if(key.startsWith('ATTO_VBR_')) delete env[key];
  env.ATTO_VBR_LANE='llvm-native';
  env.ATTO_VBR_COMPILE_ARGV_JSON=JSON.stringify(['__nonexistent_atto_compiler__','{source}','{artifact}']);
  env.ATTO_VBR_RUN_ARGV_JSON=JSON.stringify(['{artifact}']);
  const r=spawnSync(process.execPath,
    [new URL('../scripts/run-value-block-range-v0.mjs',import.meta.url).pathname],
    {encoding:'utf8',env,timeout:30000});
  assert.equal(r.status,1);
  const report=JSON.parse(r.stdout);
  assert.equal(report.passed,0);
  assert.equal(report.failed,manifest.cases.length);
});
