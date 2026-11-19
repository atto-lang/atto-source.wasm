// HOST-ONLY receipt-shape check. Synthetic data cannot certify runner, compiler, or guest execution.
import test from 'node:test';
import assert from 'node:assert/strict';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const STEPS = ['verify-exact-head', 'hash-compiler', 'compile-guest', 'execute-guest'];
function reject(reason) { throw new Error(reason); }

// This validates submitted evidence shape ONLY. Source-of-truth GitHub jobs,
// toolchain bytes, signed receipts, guest output and checkout tree still need
// independent authentication before any native-parity claim is allowed.
function checkShape(receipt, pinned) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) reject('bad receipt');
  if (!pinned || !SHA.test(pinned.head_sha) || !SHA.test(pinned.tree_sha) ||
      !DIGEST.test(pinned.compiler_sha256) || !DIGEST.test(pinned.program_sha256)) reject('bad pins');
  for (const key of ['head_sha', 'tree_sha', 'compiler_sha256', 'program_sha256'])
    if (receipt[key] !== pinned[key]) reject('mismatched ' + key);
  if (!['java','llvm','wasm','cranelift','net'].includes(receipt.backend)) reject('unknown backend');
  if (!Number.isSafeInteger(receipt.run_id) || receipt.run_id <= 0 ||
      !Number.isSafeInteger(receipt.run_attempt) || receipt.run_attempt <= 0 ||
      !Number.isSafeInteger(receipt.job_id) || receipt.job_id <= 0 ||
      !Number.isSafeInteger(receipt.runner_id) || receipt.runner_id <= 0) reject('runner admission');
  if (!Array.isArray(receipt.steps) || receipt.steps.length !== STEPS.length) reject('zero/unknown steps');
  for (let i = 0; i < STEPS.length; i++) {
    const step = receipt.steps[i];
    if (!step || step.name !== STEPS[i] || step.conclusion !== 'success' ||
        step.status !== 'completed' || step.job_id !== receipt.job_id ||
        step.run_attempt !== receipt.run_attempt) reject('unbound or skipped step');
  }
  if (!receipt.guest || receipt.guest.program_sha256 !== pinned.program_sha256 ||
      receipt.guest.compiler_sha256 !== pinned.compiler_sha256 ||
      receipt.guest.exit_code !== 42 || receipt.guest.timed_out !== false ||
      receipt.guest.skipped !== false || receipt.guest.crashed !== false ||
      !Number.isSafeInteger(receipt.guest.executed_cases) || receipt.guest.executed_cases <= 0)
    reject('guest receipt missing/invalid');
  // Even a syntactically plausible self-report remains UNVERIFIED.
  return 'SHAPE_ONLY_UNVERIFIED';
}
const pinned = Object.freeze({head_sha:'a'.repeat(40),tree_sha:'b'.repeat(40),
  compiler_sha256:'c'.repeat(64),program_sha256:'d'.repeat(64)});
function example() {
  return {backend:'java',...pinned,run_id:11,run_attempt:2,job_id:19,runner_id:7,
    steps:STEPS.map(name=>({name,status:'completed',conclusion:'success',job_id:19,run_attempt:2})),
    guest:{program_sha256:pinned.program_sha256,compiler_sha256:pinned.compiler_sha256,
      exit_code:42,timed_out:false,skipped:false,crashed:false,executed_cases:5}};
}
const copy = x => structuredClone(x);
test('synthetic complete receipt remains unverified, never native-pass evidence', () => {
  for (const backend of ['java','llvm','wasm','cranelift','net']) {
    const x = example();x.backend=backend;
    assert.equal(checkShape(x,pinned),'SHAPE_ONLY_UNVERIFIED');
  }
});
const mutations = [
 ['zero runner',x=>{x.runner_id=0;}],
 ['missing runner',x=>{delete x.runner_id;}],
 ['empty step array',x=>{x.steps=[];}],
 ['null step array',x=>{x.steps=null;}],
 ['missing compile step',x=>{x.steps.splice(2,1);}],
 ['duplicated step',x=>{x.steps[2]=copy(x.steps[1]);}],
 ['failed compiler',x=>{x.steps[2].conclusion='failure';}],
 ['skipped guest step',x=>{x.steps[3].conclusion='skipped';}],
 ['cross-job step',x=>{x.steps[3].job_id=200;}],
 ['old run attempt',x=>{x.steps[3].run_attempt=1;}],
 ['stale tree',x=>{x.tree_sha='e'.repeat(40);}],
 ['stale head',x=>{x.head_sha='e'.repeat(40);}],
 ['compiler swap',x=>{x.compiler_sha256='e'.repeat(64);}],
 ['guest compiler swap',x=>{x.guest.compiler_sha256='e'.repeat(64);}],
 ['program swap',x=>{x.guest.program_sha256='e'.repeat(64);}],
 ['guest timeout',x=>{x.guest.timed_out=true;}],
 ['guest skipped',x=>{x.guest.skipped=true;}],
 ['guest failure',x=>{x.guest.exit_code=1;}],
 ['zero guest cases',x=>{x.guest.executed_cases=0;}],
 ['unknown backend',x=>{x.backend='gpu';}],
 ['zero attempt',x=>{x.run_attempt=0;}],
 ['fractional job identifier',x=>{x.job_id=1.5;}]
];
for (const [name,mutate] of mutations) test('fail closed: '+name,()=>{
  const x=example();mutate(x);assert.throws(()=>checkShape(x,pinned));
});
test('missing or forged pins are not validated',()=>{
  assert.throws(()=>checkShape(example(),{...pinned,head_sha:'not-a-sha'}));
  assert.throws(()=>checkShape(null,pinned));
});
