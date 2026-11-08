#!/usr/bin/env node
// Local, source-only verifier. Never authorizes a GitHub merge or guest parity.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync, lstatSync, realpathSync} from 'node:fs';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const TESTS = Object.freeze([
  'tests/merge_readiness_probe_20261106.test.mjs',
  'tests/merge_readiness_dual_reviewer_mutations_20261107.test.mjs',
  'tests/merge_readiness_job_name_collision_20261107.test.mjs',
  'tests/merge_readiness_readback_setup_only_20261107.test.mjs',
]);
const SHA = /^[a-f0-9]{40}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function command(args, timeout=10_000) {
  const p = spawnSync('git', args, {cwd:ROOT, encoding:'utf8', timeout, maxBuffer:1024*1024,
    env:{PATH:process.env.PATH??'/usr/bin:/bin', LANG:'C', LC_ALL:'C'}});
  assert.ifError(p.error);
  assert.equal(p.signal,null,'Git operation interrupted');
  assert.equal(p.status,0,'Git operation failed: '+String(p.stderr).slice(0,300));
  return p.stdout.trim();
}
function clean(expected) {
  assert.equal(realpathSync(command(['rev-parse','--show-toplevel'])), ROOT,
    'runner must live in the checked-out repository');
  const head=command(['rev-parse','HEAD']);
  assert.equal(head,expected,'source HEAD differs from explicit review SHA');
  const tree=command(['rev-parse','HEAD^{tree}']);
  assert.match(tree,SHA);
  assert.equal(command(['status','--porcelain','--untracked-files=all']),'',
    'tracked or untracked repository bytes are dirty');
  return {head,tree};
}
function blobs() {
  return TESTS.map(path=>{
    const abs=join(ROOT,path);
    const info=lstatSync(abs);
    assert.ok(info.isFile()&&!info.isSymbolicLink(),path+' must be a regular file');
    const bytes=readFileSync(abs);
    const hash=command(['rev-parse','HEAD:'+path]);
    assert.match(hash,SHA);
    assert.equal(command(['hash-object','--',path]),hash,path+' bytes differ from Git HEAD');
    return {path,git_blob:hash,sha256:sha256(bytes)};
  });
}
function summary(tap,name) {
  const lines=tap.split(/\r?\n/);
  const hits=lines.filter(x=>x.startsWith('# '+name+' '));
  assert.equal(hits.length,1,'missing or ambiguous TAP '+name+' summary');
  const m=new RegExp('^# '+name+' ([0-9]+)$').exec(hits[0]);
  assert.ok(m,'invalid TAP '+name+' counter');
  return Number(m[1]);
}
async function main(){
  assert.equal(process.argv.length,3,'usage: node scripts/run_merge_readiness_exact_head.mjs <reviewed-HEAD-sha>');
  const expected=process.argv[2];
  assert.match(expected,SHA,'reviewed HEAD must be an exact 40-character lowercase Git SHA');
  assert.match(process.version,/^v22\./,'Node 22 is required');
  const before=clean(expected);
  const sources=blobs();
  const result=spawnSync(process.execPath,[
    '--test','--test-reporter=tap',...TESTS],{
    cwd:ROOT, encoding:'utf8', timeout:180_000,maxBuffer:8*1024*1024,
    env:{...process.env,NODE_ENV:'test'}
  });
  assert.ifError(result.error);
  assert.equal(result.signal,null,'Node test subprocess signalled or timed out');
  assert.equal(result.status,0,'Node tests failed: '+(result.stdout+result.stderr).slice(-1600));
  const counters=Object.fromEntries(['tests','pass','fail','skipped','cancelled','todo']
    .map(name=>[name,summary(result.stdout,name)]));
  assert.deepEqual(counters,{tests:608,pass:608,fail:0,skipped:0,cancelled:0,todo:0},
    'suite did not execute exactly 608 passing tests');
  const after=clean(expected);
  assert.deepEqual(after,before,'Git HEAD or tree changed while tests executed');
  assert.deepEqual(blobs(),sources,'a pinned test file mutated during execution');
  const receipt={schema:'atto-local-merge-readiness-v1',
    classification:'LOCAL_NODE22_SOURCE_MODEL_ONLY_NOT_HOSTED_CI',
    head:before.head, tree:before.tree, node:process.version,
    counters, source_files:sources,
    github_actions_executed:false, compiler_guest_executed:false,
    merge_authorized:false, private_source_export_authorized:false,
    guest_parity_certified:false};
  process.stdout.write(JSON.stringify(receipt,null,2)+'\n');
}
main().catch(e=>{process.stderr.write('ATTO_LOCAL_EVIDENCE_DENIED: '+e.message+'\n');process.exitCode=1;});
