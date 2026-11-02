import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!process.env.ORESLANG_LLVM_COMPILER){
  console.error('NOT_EXECUTED: ORESLANG_LLVM_COMPILER is required for real aggregate guest conformance');
  process.exit(2);
}
const test=resolve(root,'tests/inferred-aggregate-wasm32-guest.test.mjs');
const result=spawnSync(process.execPath,['--test',test],{
  cwd:root,stdio:'inherit',
  env:{...process.env,ATTO_WASM_AGGREGATE_REAL_GUEST:'1'}
});
if(result.error)throw result.error;
process.exit(result.status===null?1:result.status);
