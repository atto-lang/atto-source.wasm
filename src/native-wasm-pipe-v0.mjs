// Experimental trusted local-process native ↔ WASM DATA round-trip.
// No native OresVM actor authority is exported, no ActorRef wire format,
// no supervisor CONTROL, no remote/network trust boundary, no source spawn.
// The native peer is a C++ wire-compatibility executable built in the LLVM repo.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {once} from 'node:events';
import {PooledWasmActors} from './pooled-actor-host.mjs';
import {readBoundedRegularFile} from '../scripts/compile-ores.mjs';
import {REQUEST_SCHEMA, RESPONSE_SCHEMA, ACK_SCHEMA,
  MAX_FRAME_BYTES, encodeNativeWasmPair, decodeNativeWasmPair,
  frameNativeWasm, NativeWasmFrameReader} from './native-wasm-wire-v0.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function runTrustedNativeWasmLoop({
  nativeExecutable, expectedNativeSha256, wasm, expectedWasmSha256,
  actorCount = 40, turns = 1000, timeoutMs = 30000, trusted = false
} = {}) {
  if (trusted !== true) throw Error('native/WASM loop requires trusted local admission');
  if (!isAbsolute(nativeExecutable || '') || !pin(expectedNativeSha256) ||
      !pin(expectedWasmSha256))
    throw Error('absolute native binary and exact native/WASM SHA-256 pins required');
  if (!Number.isSafeInteger(actorCount) || actorCount < 1 || actorCount > 40 ||
      !Number.isSafeInteger(turns) || turns < 1 || turns > 10000 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    throw RangeError('invalid native/WASM loop budgets');

  const native = (await readBoundedRegularFile(nativeExecutable, 16*1024*1024,
    'native peer exceeds 16 MiB')).bytes;
  if (sha(native) !== expectedNativeSha256) throw Error('native peer hash mismatch');
  const tmp = await mkdtemp(join(tmpdir(), 'ores-native-wasm-loop-'));
  const staged = join(tmp, 'native-exact');
  let pool, child, failure, stderr = '', exitCode = null, exitPromise;
  let timer;
  try {
    await writeFile(staged, native, {mode: 0o500, flag: 'wx'});
    if (sha((await readBoundedRegularFile(staged,16*1024*1024)).bytes)!==expectedNativeSha256)
      throw Error('staged native peer digest mismatch');
    pool = new PooledWasmActors({workers:2,maxActors:actorCount,
      mailboxCapacity:2,timeoutMs:Math.min(5000,timeoutMs)});
    const actors = await Promise.all(Array.from({length:actorCount}, () =>
      pool.spawn(wasm,{expectedSha256:expectedWasmSha256,trusted:true})));

    child = spawn(staged,[String(turns),String(actorCount)],{
      stdio:['pipe','pipe','pipe'],shell:false,env:{PATH:process.env.PATH||''}
    });
    child.on('error', e => {failure ||= e;});
    child.stdin.on('error', e => {failure ||= e;});
    child.stderr.on('data', chunk => {
      stderr = (stderr + Buffer.from(chunk).toString('utf8')).slice(-2048);
    });
    exitPromise = new Promise(resolve => child.once('close', (code,signal) => {
      exitCode = {code,signal}; resolve(exitCode);
    }));
    timer = setTimeout(() => {failure ||= Error('native/WASM loop deadline exceeded');
      child.kill('SIGKILL');},timeoutMs);

    const reader = new NativeWasmFrameReader();
    let nextRequest = 1n, nextAck = 1n, pending = null;
    for await (const chunk of child.stdout) {
      for (const bytes of reader.push(chunk)) {
        if (failure) throw failure;
        if (bytes.length > MAX_FRAME_BYTES) throw Error('native peer oversized DATA');
        if (pending === null) {
          if (nextRequest > BigInt(turns))
            throw Error('native peer exceeded admitted turn budget');
          const msg = decodeNativeWasmPair(REQUEST_SCHEMA,bytes);
          if (msg.ticket !== nextRequest || msg.value !== 1n)
            throw Error('unexpected/replayed native actor request');
          const index = Number((msg.ticket - 1n) % BigInt(actorCount));
          const result = await actors[index].send(msg.value);
          const expected = (msg.ticket - 1n) / BigInt(actorCount) + 1n;
          if (result !== expected) throw Error('WASM actor state or routing mismatch');
          pending = {ticket:msg.ticket, expectedAck:result+100n};
          const response = frameNativeWasm(encodeNativeWasmPair(
            RESPONSE_SCHEMA,msg.ticket,result));
          if (!child.stdin.write(response)) await once(child.stdin,'drain');
          nextRequest++;
        } else {
          const ack = decodeNativeWasmPair(ACK_SCHEMA,bytes);
          if (ack.ticket !== nextAck || ack.ticket !== pending.ticket ||
              ack.value !== pending.expectedAck)
            throw Error('unexpected/replayed native receipt');
          pending = null; nextAck++;
        }
      }
    }
    reader.end();
    await exitPromise;
    if (failure) throw failure;
    if (exitCode.code !== 0 || exitCode.signal)
      throw Error('native peer rejected DATA: '+stderr);
    if (pending !== null || nextRequest !== BigInt(turns+1) ||
        nextAck !== BigInt(turns+1))
      throw Error('incomplete native/WASM DATA exchange');
    await Promise.all(actors.map(a=>a.stop()));
    return Object.freeze({turns, actorCount, workerCount:pool.workerCount,
      wasmSha256:expectedWasmSha256,nativeSha256:expectedNativeSha256,
      protocol:'trusted-local-MessagePack-v2-i64-tuple'});
  } catch (e) {
    if (child && exitCode === null) {
      child.kill('SIGKILL');
      if (exitPromise) await exitPromise;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (pool) await pool.close();
    await rm(tmp,{recursive:true,force:true});
  }
}
