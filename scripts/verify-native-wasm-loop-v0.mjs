import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const vars=['ORESLANG_LLVM_COMPILER','ORESLANG_NATIVE_WASM_PEER'];
const digests=['ORESLANG_LLVM_COMPILER_SHA256','ORESLANG_NATIVE_WASM_PEER_SHA256'];
let valid=true;
for(const name of vars) {
  if(typeof process.env[name]!=='string'||!process.env[name].startsWith('/')) {
    console.error('NOT_EXECUTED: absolute path required: '+name); valid=false;
  }
}
for(const name of digests) {
  if(!/^[a-f0-9]{64}$/.test(process.env[name]||'')) {
    console.error('NOT_EXECUTED: executable SHA-256 pin required: '+name); valid=false;
  }
}
if(!valid) process.exitCode=1;
else {
  const file=fileURLToPath(new URL('../tests/native-wasm-pipe-v0.test.mjs',import.meta.url));
  const r=spawnSync(process.execPath,['--test',file],{
    env:{...process.env,REQUIRE_NATIVE_WASM_LOOP:'1'},
    stdio:'inherit',timeout:120000
  });
  process.exitCode=r.error||r.signal?1:r.status;
}
