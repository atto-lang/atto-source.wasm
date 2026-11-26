import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
  env.ATTO_VBR_TYPECHECK_ARGV_JSON=JSON.stringify(['__nonexistent_atto_compiler__','--typecheck-json','{source}']);
  env.ATTO_VBR_PARSE_ARGV_JSON=JSON.stringify(['__nonexistent_atto_compiler__','--parse','{source}']);
  const r=spawnSync(process.execPath,
    [new URL('../scripts/run-value-block-range-v0.mjs',import.meta.url).pathname],
    {encoding:'utf8',env,timeout:30000});
  assert.equal(r.status,1);
  const report=JSON.parse(r.stdout);
  assert.equal(report.passed,0);
  assert.equal(report.failed,manifest.cases.length);
});

test('all ten backends fail closed with no real compiler configured',()=>{
  for(const lane of [
    'java-interpreter','java-native-image','llvm-native','wasm32',
    'forge-native','net-native-aot','rs-native','cranelift-native',
    'js-worker','hdl-rtl-simulation'
  ]) {
    const env={...process.env,ATTO_VBR_LANE:lane};
    for(const key of Object.keys(env)) if(key.startsWith('ATTO_VBR_') && key!=='ATTO_VBR_LANE') delete env[key];
    const result=spawnSync(process.execPath,
      [new URL('../scripts/run-value-block-range-v0.mjs',import.meta.url).pathname],
      {encoding:'utf8',env,timeout:10000});
    assert.equal(result.status,1);
    const report=JSON.parse(result.stdout);
    assert.equal(report.lane,lane);
    assert.equal(report.certified_guest_passes,0);
    assert.match(report.observations[0].detail,/COMPILE_ARGV_JSON/);
  }
});


test('synthetic compiler must not certify missing range witnesses',()=>{
  const dir=mkdtempSync(join(tmpdir(),'atto-vbr-mock-'));
  try{
    const script=join(dir,'mock-compiler.mjs');
    writeFileSync(script,"import {writeFileSync} from 'node:fs';\nconst [phase,source,artifact]=process.argv.slice(2);\nconst vectors=JSON.parse(process.env.ATTO_VBR_FAKE_EXPECTATIONS);\nconst v=vectors[process.env.ATTO_VALUE_BLOCK_RANGE_CASE];\nif(!v)process.exit(92);\nif(phase==='lex'){console.log(JSON.stringify(v.token_prefix||[]));process.exit(0)}\nif(phase==='parse'){if(v.kind==='reject_parse'){console.error(v.diagnostic);process.exit(2)}process.exit(0)}\nif(phase==='typecheck'){if(v.kind==='reject_typecheck'){console.error(v.diagnostic);process.exit(3)}console.log(JSON.stringify({result_type:v.result_type||'int'}));process.exit(0)}\nif(phase==='compile'){if(v.kind!=='accept_execute')process.exit(88);writeFileSync(artifact,'process.exit('+v.exit_code+');\\n');process.exit(0)}\nprocess.exit(93)\n",'utf8');
    const env={...process.env};
    for(const key of Object.keys(env))if(key.startsWith('ATTO_VBR_'))delete env[key];
    env.ATTO_VBR_FAKE_EXPECTATIONS=JSON.stringify(Object.fromEntries(
      manifest.cases.map(v=>[v.id,{kind:v.kind,...v.expect}])));
    const command=(phase,...args)=>JSON.stringify([process.execPath,script,phase,...args]);
    env.ATTO_VBR_LANE='rs-native';
    env.ATTO_VBR_COMPILE_ARGV_JSON=command('compile','{source}','{artifact}');
    env.ATTO_VBR_TYPECHECK_ARGV_JSON=command('typecheck','{source}');
    env.ATTO_VBR_PARSE_ARGV_JSON=command('parse','{source}');
    env.ATTO_VBR_LEX_ARGV_JSON=command('lex','{source}');
    env.ATTO_VBR_RUN_ARGV_JSON=JSON.stringify([process.execPath,'{artifact}']);
    const result=spawnSync(process.execPath,
      [new URL('../scripts/run-value-block-range-v0.mjs',import.meta.url).pathname],
      {encoding:'utf8',env,timeout:120000,maxBuffer:4*1024*1024});
    assert.equal(result.status,1);
    const report=JSON.parse(result.stdout);
    assert.equal(report.certified_guest_passes,0);
    assert.equal(report.evidence_class,'UNVERIFIED_LOCAL_COMPILER_OBSERVATIONS');
    assert.equal(report.observations.find(x=>x.id==='range_exclusive_count').status,'failed');
    assert.match(report.observations.find(x=>x.id==='range_exclusive_count').detail,/visited-sequence witness/);
    assert.equal(report.observations.find(x=>x.id==='empty_collection_context').phase,'typecheck');
    assert.equal(report.observations.find(x=>x.id==='range_chaining').phase,'parser-reject');
    assert.equal(report.observations.find(x=>x.id==='non_bool_ternary').phase,'typechecker-reject');
  }finally{rmSync(dir,{recursive:true,force:true})}
});
