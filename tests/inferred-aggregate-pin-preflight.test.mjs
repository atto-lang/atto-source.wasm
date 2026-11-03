import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/verify-real-aggregate-wasm32.mjs',import.meta.url));
const env={...process.env,ORESLANG_LLVM_COMPILER:process.execPath};
delete env.ATTO_WASM_AGGREGATE_COMPILER_SHA256;
delete env.ATTO_WASM_AGGREGATE_LLVM_SOURCE_SHA;
function denied(override,message){
 const p=spawnSync(process.execPath,[script],{env:{...env,...override},encoding:'utf8',timeout:10000});
 assert.equal(p.status,2,p.stderr);
 assert.match(p.stderr,message);
 assert.doesNotMatch(p.stderr,/Cannot find module/);
}
test('reject absent compiler pin',()=>denied({},/ATTO_WASM_AGGREGATE_COMPILER_SHA256/));
test('reject nonhex compiler pin',()=>denied({ATTO_WASM_AGGREGATE_COMPILER_SHA256:'f'.repeat(63)+'G'},/ATTO_WASM_AGGREGATE_COMPILER_SHA256/));
test('reject missing source pin',()=>denied({ATTO_WASM_AGGREGATE_COMPILER_SHA256:'a'.repeat(64)},/ATTO_WASM_AGGREGATE_LLVM_SOURCE_SHA/));
test('reject invalid source pin',()=>denied({ATTO_WASM_AGGREGATE_COMPILER_SHA256:'a'.repeat(64),ATTO_WASM_AGGREGATE_LLVM_SOURCE_SHA:'z'.repeat(40)},/ATTO_WASM_AGGREGATE_LLVM_SOURCE_SHA/));
