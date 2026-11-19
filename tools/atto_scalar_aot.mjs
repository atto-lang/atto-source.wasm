#!/usr/bin/env node
// Development-only .atto -> LLVM IR -> Wasm32 -> Wasmtime native AOT bridge.
// Requires an exact SHA-pinned real compiler; no C/mock/IR fallback is allowed.
import {createHash} from 'node:crypto';
import {accessSync,constants,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,extname,join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const HEX64=/^[a-f0-9]{64}$/;
const MAX_SOURCE=1<<20,MAX_IR=4<<20,MAX_WASM=16<<20,MAX_AOT=64<<20;
class NotExecuted extends Error {}
function deny(msg){throw new NotExecuted(msg)}
function sha256(data){return createHash('sha256').update(data).digest('hex')}
function readPinned(filename,digest,max){
  if(!HEX64.test(digest))deny('input SHA256 pin invalid: '+filename);
  let stat;
  try { stat=lstatSync(filename) } catch {deny('missing, nonregular or symlinked input '+filename)}
  if(!stat.isFile() || stat.isSymbolicLink())deny('missing, nonregular or symlinked input '+filename);
  if(stat.size===0 || stat.size>max)deny('input byte budget rejected: '+filename);
  const bytes=readFileSync(filename);
  if(bytes.length!==stat.size || sha256(bytes)!==digest)deny('input SHA256 does not match the pinned bytes: '+filename);
  return bytes;
}
function executable(filename,digest){
  if(typeof filename!=='string' || !filename)deny('missing or nonexecutable tool: '+filename);
  try {accessSync(filename,constants.X_OK)}catch{deny('missing or nonexecutable tool: '+filename)}
  readPinned(filename,digest,150<<20);
  return realpathSync(filename);
}
function execute(tool,args,max=MAX_IR){
  const r=spawnSync(tool,args,{stdio:['ignore','pipe','pipe'],timeout:120000,maxBuffer:max+32768,windowsHide:true});
  if(r.error || r.signal || r.status!==0 || !r.stdout || r.stdout.length>max || r.stderr.length>32768)
    deny('tool rejected input, failed or exceeded output limit: '+tool);
  return [r.stdout,r.stderr];
}
const allowed=new Set(['--source-sha256','--compiler','--compiler-sha256',
  '--wasm-clang','--wasm-clang-sha256','--wasm-ld','--wasm-ld-sha256',
  '--precompiler','--precompiler-sha256','--out','--debug-runner',
  '--debug-runner-sha256','--expect-scalar']);
function parse(args){
  if(args.length<1 || args[0].startsWith('--'))deny('actual .atto source path required');
  const out={source:args[0]};
  for(let i=1;i<args.length;i+=2){
    const key=args[i];
    if(!allowed.has(key) || i+1>=args.length || Object.hasOwn(out,key))deny('invalid/duplicate CLI flag: '+key);
    out[key]=args[i+1];
  }
  for(const key of ['--source-sha256','--compiler','--compiler-sha256',
    '--wasm-clang','--wasm-clang-sha256','--wasm-ld','--wasm-ld-sha256',
    '--precompiler','--precompiler-sha256','--out']){
    if(!Object.hasOwn(out,key))deny('missing required flag: '+key);
  }
  return out;
}
function inspectScalarWasm(wasm){
  if(!WebAssembly.validate(wasm))deny('linker produced invalid core wasm32');
  const module=new WebAssembly.Module(wasm);
  if(WebAssembly.Module.imports(module).length!==0)deny('native scalar guest imports forbidden');
  const exports=WebAssembly.Module.exports(module);
  if(!exports.some(e=>e.name==='main'&&e.kind==='function') ||
     !exports.some(e=>e.name==='memory'&&e.kind==='memory'))deny('scalar guest exports missing');
  // The native builder retains final responsibility for its exact Wasm profile.
}
export function runScalarBridge(argv){
  const a=parse(argv),source=resolve(a.source);
  if(extname(source)!=='.atto')deny('only actual .atto source is accepted');
  const sourceBytes=readPinned(source,a['--source-sha256'],MAX_SOURCE);
  const compiler=executable(a['--compiler'],a['--compiler-sha256']);
  const builder=executable(a['--precompiler'],a['--precompiler-sha256']);
  if(Boolean(a['--debug-runner'])!==Boolean(a['--debug-runner-sha256']))
    deny('debug runner and digest must be provided together');
  if(Boolean(a['--expect-scalar'])!==Boolean(a['--debug-runner']))
    deny('expected observed scalar is required only with debug runner');
  if(a['--expect-scalar'] && !/^-?\d+$/.test(a['--expect-scalar']))deny('invalid expected scalar');
  const runner=a['--debug-runner']?executable(a['--debug-runner'],a['--debug-runner-sha256']):null;
  const clang=executable(a['--wasm-clang'],a['--wasm-clang-sha256']);
  const ld=executable(a['--wasm-ld'],a['--wasm-ld-sha256']);
  const final=resolve(a['--out']);
  if(existsSync(final) || (()=>{try{lstatSync(final);return true}catch{return false}})())
    deny('output directory already exists; refusal to overwrite artifacts');
  const temp=mkdtempSync(join(tmpdir(),'atto-wasm-aot-'));
  try{
    const pinnedSource=join(temp,'source.atto');writeFileSync(pinnedSource,sourceBytes,{flag:'wx'});
    const [ir]=execute(compiler,['--target=wasm32',pinnedSource]);
    const text=ir.toString('utf8');
    if(!ir.length||!/wasm32/.test(text)||!/\bdefine\b/.test(text)||!/@main\b/.test(text))
      deny('LLVM compiler emitted no wasm32 main IR; unsupported guest ABI');
    const irPath=join(temp,'source.ll'),obj=join(temp,'source.o'),wasmPath=join(temp,'source.wasm');
    writeFileSync(irPath,ir,{flag:'wx'});
    execute(clang,['--target=wasm32-unknown-unknown','-Oz','-nostdlib',
      '-mno-bulk-memory','-mno-reference-types','-mno-simd128',
      '-x','ir','-c',irPath,'-o',obj]);
    execute(ld,['--no-entry','--export=main','--export-memory',
      '--initial-memory=131072','--max-memory=131072','--gc-sections',obj,'-o',wasmPath]);
    const wasm=readFileSync(wasmPath);
    if(wasm.length<8||wasm.length>MAX_WASM)deny('wasm32 output byte budget rejected');
    inspectScalarWasm(wasm);
    const wasmSha=sha256(wasm),aotPath=join(temp,'source.cwasm');
    const [builderOut]=execute(builder,[wasmPath,wasmSha,aotPath],4096);
    if(!existsSync(aotPath))deny('precompiler produced no native AOT module');
    const aot=readFileSync(aotPath);
    if(!aot.length || aot.length>MAX_AOT)deny('precompiled artifact byte budget rejected');
    const aotSha=sha256(aot);
    if(!builderOut.toString('ascii').split(/\r?\n/).includes('aot_sha256='+aotSha))
      deny('precompiler output digest mismatch');
    let observed=null;
    if(runner){
      const [stdout,stderr]=execute(runner,[aotPath,aotSha],128);
      if(stderr.length || stdout.toString('ascii')!==a['--expect-scalar']+'\n')
        deny('real native guest scalar output mismatch');
      observed=Number(a['--expect-scalar']);
    }
    const manifest={schema:'atto.scalar-compiler-to-wasmtime-aot.v1',
      execution_profile:'LOCAL_DEVELOPMENT_NOT_PRODUCTION',source_file:basename(source),
      source_sha256:sha256(sourceBytes),llvm_compiler_sha256:a['--compiler-sha256'],
      llvm_ir_sha256:sha256(ir),wasm_sha256:wasmSha,aot_sha256:aotSha,
      guest_executed:runner!==null,observed_scalar:observed,
      safety:'import-free scalar Wasm only; caller hash is not deployment authorization'};
    mkdirSync(final);
    writeFileSync(join(final,'source.wasm'),wasm,{flag:'wx'});
    writeFileSync(join(final,'source.cwasm'),aot,{flag:'wx'});
    writeFileSync(join(final,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    console.log('ATTO_SCALAR_AOT_BRIDGE='+(runner?'EXECUTED':'PRECOMPILED_ONLY'));
    console.log('ATTO_SCALAR_AOT_SHA256='+aotSha);
    console.log('EVIDENCE_SCOPE=ACTUAL_COMPILER_REQUIRED_SCALAR_ABI_NOT_ACTOR_TENANT_SECURITY');
  }finally{rmSync(temp,{recursive:true,force:true});}
}
if(import.meta.url===new URL('file://'+resolve(process.argv[1]||'')).href){
  try {runScalarBridge(process.argv.slice(2))}
  catch(error){
    console.error('ATTO_SCALAR_AOT_NOT_EXECUTED: '+String(error.message||error));
    process.exitCode=2;
  }
}
