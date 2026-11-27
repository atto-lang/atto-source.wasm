import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertScalarActorAbi} from '../scripts/actor-scalar-abi.mjs';
import {PooledWasmActors} from '../src/pooled-actor-host.mjs';
import {createHash} from 'node:crypto';

function compile(returns = 'i64', initReturns = 'void', teardownReturns = 'void') {
  const dir = mkdtempSync(join(tmpdir(), 'ores-actor-abi-'));
  const output = join(dir, 'actor.wasm');
  const initReturn = initReturns === 'void' ? 'ret void' : 'ret i64 1';
  const teardownReturn = teardownReturns === 'void' ? 'ret void' : 'ret i64 1';
  const ir = 'target triple = "wasm32-unknown-unknown"\n' +
    'define '+initReturns+' @oreslang_wasm_actor_init() { '+initReturn+' }\n' +
    'define '+returns+' @oreslang_wasm_actor_on_message(i64 %x) { ret '+returns+' 7 }\n' +
    'define '+teardownReturns+' @oreslang_wasm_actor_teardown() { '+teardownReturn+' }\n';
  const args = ['--target=wasm32','-x','ir','-Oz','-nostdlib',
    '-Wl,--no-entry','-Wl,--export-memory',
    '-Wl,--initial-memory=131072','-Wl,--max-memory=131072',
    '-Wl,--export=oreslang_wasm_actor_init',
    '-Wl,--export=oreslang_wasm_actor_on_message',
    '-Wl,--export=oreslang_wasm_actor_teardown','-o',output,'-'];
  try {
    const p = spawnSync(process.env.CLANG||'clang',args,{input:ir,encoding:'utf8',timeout:30000});
    if (p.status !== 0 || p.error) throw Error('Clang unavailable: '+(p.stderr||p.error));
    return readFileSync(output);
  } finally {rmSync(dir,{force:true,recursive:true});}
}
test('binary ABI accepts precisely void/init, i64(i64)/handler, void/teardown', () => {
  assert.equal(assertScalarActorAbi(compile()),true);
});
test('wrong handler result, init result and teardown result fail pre-execution', () => {
  assert.throws(()=>assertScalarActorAbi(compile('i32')),/incorrect function signature: oreslang_wasm_actor_on_message/);
  assert.throws(()=>assertScalarActorAbi(compile('i64','i64')),/incorrect function signature: oreslang_wasm_actor_init/);
  assert.throws(()=>assertScalarActorAbi(compile('i64','void','i64')),/incorrect function signature: oreslang_wasm_actor_teardown/);
});

test('pooled actor worker rejects a forged ABI before guest initialization', async () => {
  const wasm = compile('i32');
  const pool = new PooledWasmActors({workers: 1});
  try {
    await assert.rejects(pool.spawn(wasm, {trusted: true,
      expectedSha256: createHash('sha256').update(wasm).digest('hex')}),
      /incorrect function signature: oreslang_wasm_actor_on_message/);
    assert.equal(pool.actorCount, 0);
  } finally {await pool.close();}
});

test('wrong handler signature is rejected without poisoning a healthy carrier peer', async () => {
  const good = compile('i64'), bad = compile('i32');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const pool = new PooledWasmActors({workers: 1});
  try {
    const healthy = await pool.spawn(good, {trusted: true, expectedSha256: sha(good)});
    assert.equal(await healthy.send(1n), 7n);
    await assert.rejects(pool.spawn(bad, {trusted: true, expectedSha256: sha(bad)}),
      /incorrect function signature: oreslang_wasm_actor_on_message/);
    assert.equal(pool.actorCount, 1);
    assert.equal(await healthy.send(3n), 7n);
    await healthy.stop();
  } finally {await pool.close();}
});
