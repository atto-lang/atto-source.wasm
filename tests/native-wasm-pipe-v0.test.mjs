import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {compileSourceActorToWasm} from '../scripts/compile-source-actor.mjs';
import {runTrustedNativeWasmLoop} from '../src/native-wasm-pipe-v0.mjs';

const compiler=process.env.ORESLANG_LLVM_COMPILER;
const compilerSha=process.env.ORESLANG_LLVM_COMPILER_SHA256;
const native=process.env.ORESLANG_NATIVE_WASM_PEER;
const nativeSha=process.env.ORESLANG_NATIVE_WASM_PEER_SHA256;
const required=process.env.REQUIRE_NATIVE_WASM_LOOP==='1';
const configured=Boolean(compiler&&compilerSha&&native&&nativeSha);
const fixture=fileURLToPath(new URL('./fixtures/wasm32-single-source-actor.ores',import.meta.url));

test('real LLVM .ores guest ↔ LLVM-native C++ MessagePack-v2 peer, 1000 roundtrips',
  {skip:!configured&&!required?'requires real compiler, native peer, and binary pins':false},
  async ()=>{
    assert.ok(configured,'real LLVM compiler, native C++ wire peer and exact SHA256 pins required');
    const artifact=await compileSourceActorToWasm({
      compiler,source:fixture,expectedCompilerSha256:compilerSha});
    const result=await runTrustedNativeWasmLoop({
      nativeExecutable:native,expectedNativeSha256:nativeSha,
      wasm:artifact.wasm,expectedWasmSha256:artifact.provenance.wasmSha256,
      actorCount:40,turns:1000,trusted:true,timeoutMs:60000});
    assert.equal(result.turns,1000);
    assert.equal(result.actorCount,40);
    assert.equal(result.workerCount,2);
    assert.equal(result.protocol,'trusted-local-MessagePack-v2-i64-tuple');
  });
