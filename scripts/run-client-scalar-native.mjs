// Strict opt-in real Oreslang -> LLVM IR -> Wasm -> isolated guest oracle.
// No fallback compiler, source rewriting, mocks or skipped backend passes.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, lstatSync, existsSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, isAbsolute, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const sourceRoot=join(root,'tests/fixtures/clients-scalar-v1');
const positive=[
 ['01-precedence', '14', 'e42464360ffa360b263bc74f74ef485e6a9e4eb9dff601ead2c4576982622576'],
 ['02-grouping', '20', '9196a61de9c4710bdf32e658de396c521ad2abb2e3d03ce711ae449ac7aa5a2f'],
 ['03-signed', '5', '613d1e1e104361ce555f397dd0d23754d44ade5b80750147110c1e4a73cce286'],
 ['04-i64-edge', '1', 'b0f80c76a24cb15ed25fee0bdaa096d7cbcd318f787f7d8a040166c127532247'],
 ['05-separators', '100', '2bcfdc119d3e48b9ac97e2061b7b88571d6e621b04ecabf886347d9eeb19382c'],
 ['06-nested', '35', 'dd1bf333cdd17140571227e810427030a279666b8a4d06eb5968a056cf5a8a2a']
];
const negative=[
 ['07-unknown-reject','c45493f0814253ab5a2e8896d8b39643c7b8e1247d408eef11baccd79d6580e1',/unknown|undefined|undeclared|unresolved|symbol|identifier/i],
 ['08-overflow-reject','37b793a36e231ee37d953b8359cd0f004dc008a795eb32a413762a0a504c542c',/overflow|range|literal|integer/i],
 ['09-syntax-reject','32f4b30c52ce58955ecbb0aa0d564f0ac394737940faaab01351e25ed9df4b75',/syntax|parse|expected|token|unexpected/i]
];

function result(cmd,args,expectOk){
 const v=spawnSync(cmd,args,{cwd:root,timeout:45000,maxBuffer:1024*1024,encoding:'utf8',
   env:{PATH:process.env.PATH||'/usr/bin:/bin',HOME:process.env.HOME||'/tmp',LANG:'C',TZ:'UTC'}});
 if(v.error)throw Error('toolchain process failed or timed out: '+v.error.code);
 if(expectOk ? v.status!==0 : v.status===0)throw Error('unexpected toolchain exit status: '+cmd);
 if(v.signal)throw Error('toolchain process terminated by signal');
 return v;
}
function checkSource(name,pin){
 const path=join(sourceRoot,name+'.ores');
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||stat.size<20)
   throw Error('invalid source fixture');
 if(sha(readFileSync(path))!==pin)throw Error('source SHA-256 mismatch: '+name);
 return path;
}
function parseJson(out,label){
 try{return JSON.parse(out.trim())}catch{throw Error('not valid JSON from '+label)}
}
export function validateCompiler(path,pin){
 if(!isAbsolute(path)||!/^[a-f0-9]{64}$/.test(pin||''))throw Error('compiler and SHA-256 pin required');
 const stat=lstatSync(path);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024*1024||stat.size===0)
   throw Error('compiler file is not an admitted regular file');
 if(sha(readFileSync(path))!==pin)throw Error('compiler binary has wrong SHA-256');
 return true;
}
export function compilerOwnedDenial(stderr, expectedCategory) {
 if(typeof stderr!=='string'||!(expectedCategory instanceof RegExp))return false;
 // The compiler bridge wraps the real native compiler's stderr in this
 // form. Other tool failures can mention the source name, so matching the
 // whole JS stack (or stderr filename) is never enough.
 const owned=/command failed \(([^)]+)\): ([^\r\n]+)/.exec(stderr);
 return Boolean(owned&&owned[1].endsWith('/compiler-exact')&&
   expectedCategory.test(owned[2])&&
   !/segmentation fault|panicked at|stack backtrace|internal compiler error|fatal error/i.test(stderr));
}
export function runScalar(){
 const compiler=process.env.ORESLANG_LLVM_COMPILER;
 const compilerSha=process.env.ORESLANG_LLVM_COMPILER_SHA256;
 validateCompiler(compiler,compilerSha);
 const working=mkdtempSync(join(tmpdir(),'oreslang-client-wasm-'));
 try{
  for(const [name,value,sourceSha] of positive){
   const source=checkSource(name,sourceSha),artifact=join(working,name+'.wasm');
   const compile=result(process.execPath,[
     join(root,'scripts/compile-ores.mjs'),
     '--compiler='+compiler,'--compiler-sha256='+compilerSha,
     '--source='+source,'--output='+artifact
   ],true);
   const receipt=parseJson(compile.stdout,'compiler');
   if(!existsSync(artifact)||sha(readFileSync(artifact))!==receipt.wasmSha256||
     receipt.sourceSha256!==sourceSha||receipt.compilerSha256!==compilerSha)
     throw Error('compiler provenance or artifact mismatch: '+name);
   const run=result(process.execPath,[
     join(root,'scripts/run-guest.mjs'),'--wasm='+artifact,
     '--sha256='+receipt.wasmSha256,'--timeout-ms=2000'
   ],true);
   const guest=parseJson(run.stdout,'guest');
   if(guest.resultType!=='i64'||guest.value!==value)
     throw Error('wrong Wasm guest value: '+name);
  }
  for(const [name,sourceSha,diagnostic] of negative){
   const source=checkSource(name,sourceSha),artifact=join(working,name+'.wasm');
   const denial=result(process.execPath,[
     join(root,'scripts/compile-ores.mjs'),
     '--compiler='+compiler,'--compiler-sha256='+compilerSha,
     '--source='+source,'--output='+artifact
   ],false);
   // Inspect only the actual native frontend's diagnostic payload. Looking
   // for "unknown" in the whole stack could match the source filename and
   // falsely admit a Clang, runner, or artifact-publication failure.
   if(!compilerOwnedDenial(denial.stderr,diagnostic))
     throw Error('wrong native compiler denial reason: '+name);
   for(const suffix of ['','.provenance.json','.artifact.json','.release.json',
                        '.current.json','.publication.lock']){
    if(existsSync(artifact+suffix))throw Error('rejected source published Wasm artifacts: '+name);
   }
   if(existsSync(artifact+'.releases'))
    throw Error('rejected source created a Wasm release directory: '+name);
  }
  console.log('WASM_CLIENT_SCALAR_6_GUEST_RESULTS_3_COMPILER_DENIALS');
 }finally{rmSync(working,{recursive:true,force:true})}
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{runScalar()}catch(e){console.error('Wasm scalar parity blocked: '+e.message);process.exitCode=1}
}
