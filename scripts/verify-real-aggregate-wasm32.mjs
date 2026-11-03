import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const compiler=process.env.ORESLANG_LLVM_COMPILER;
const compilerPin=process.env.ATTO_WASM_AGGREGATE_COMPILER_SHA256;
const sourcePin=process.env.ATTO_WASM_AGGREGATE_LLVM_SOURCE_SHA;
if(!compiler){
  console.error('NOT_EXECUTED: ORESLANG_LLVM_COMPILER is required for real aggregate guest conformance');
  process.exit(2);
}
if(typeof compilerPin!=='string'||!/^[0-9a-f]{64}$/.test(compilerPin)){
  console.error('NOT_EXECUTED: ATTO_WASM_AGGREGATE_COMPILER_SHA256 must be an independently supplied 64-character lowercase SHA-256');
  process.exit(2);
}
if(typeof sourcePin!=='string'||!/^[0-9a-f]{40}$/.test(sourcePin)){
  console.error('NOT_EXECUTED: ATTO_WASM_AGGREGATE_LLVM_SOURCE_SHA must identify the exact 40-character lowercase LLVM source commit');
  process.exit(2);
}
// These are caller-supplied assertions, not independent proof that the binary
// was built from sourcePin. A trusted CI build receipt must establish that link.
const test=resolve(root,'tests/inferred-aggregate-wasm32-guest.test.mjs');
const result=spawnSync(process.execPath,['--test',test],{
  cwd:root,stdio:'inherit',
  env:{...process.env,ATTO_WASM_AGGREGATE_REAL_GUEST:'1'}
});
if(result.error)throw result.error;
process.exit(result.status===null?1:result.status);
