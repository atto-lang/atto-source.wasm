/**
 * Experimental, explicit end-to-end bridge:
 * native oreslang-llvmc (.ores -> LLVM IR) -> clang wasm32 -> Wasm module.
 * There is no fallback or mock compiler; caller must pass a real binary.
 */
import {spawnSync} from "node:child_process";
import {constants} from "node:fs";
import {createHash} from "node:crypto";
import {writeFile,mkdir,mkdtemp,rm,rename,realpath,stat,open} from "node:fs/promises";
import {dirname,resolve,isAbsolute,join,basename} from "node:path";
import {fileURLToPath} from "node:url";
import {assertCoreI64Entry} from "./core-i64-abi.mjs";
import {inspectWasmBytes} from "./inspect-core-memory.mjs";
import {assertWasm32IrTarget} from "./wasm32-ir-target.mjs";
import {publishAtomicRelease} from "./atomic-release.mjs";
const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const MAX_SOURCE_BYTES=1024*1024,MAX_COMPILER_BYTES=256*1024*1024,MAX_WASM_BYTES=16*1024*1024;
// A preflight stat + readFile(path) is not a byte-budget: the file can be
// replaced or expanded before readFile allocates. Open once with NOFOLLOW,
// reject FIFOs/non-files, read exactly the statted budget and verify the
// opened inode did not change during the copy.
export async function readBoundedRegularFile(path,maxBytes,errorLabel="input exceeds byte budget"){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>MAX_COMPILER_BYTES)
  throw new TypeError("invalid input byte budget");
 if(!Number.isInteger(constants.O_NOFOLLOW)||!Number.isInteger(constants.O_NONBLOCK))
  throw Error("bounded no-follow file reads unsupported on this host");
 let fd;
 try{fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)}
 catch(error){
  if(["ELOOP","EISDIR","ENXIO"].includes(error?.code))
   throw Error("symlink or special input file is forbidden");
  throw error;
 }
 try{
  const before=await fd.stat();
  if(!before.isFile()||!Number.isSafeInteger(before.size)||
     before.size<0||before.size>maxBytes)throw Error(errorLabel);
  const bytes=Buffer.alloc(before.size);
  let at=0;
  while(at<bytes.length){
   const {bytesRead}=await fd.read(bytes,at,bytes.length-at,at);
   if(bytesRead===0)throw Error("input was truncated during snapshot");
   at+=bytesRead;
  }
  const after=await fd.stat();
  if(!after.isFile()||after.size!==before.size||
     after.dev!==before.dev||after.ino!==before.ino||
     after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)
   throw Error("input changed during snapshot");
  return {bytes,stat:before};
 }finally{await fd.close()}
}

function rejectStartSection(bytes){
 let i=8;
 const u32=()=>{let value=0;for(let j=0;j<5;j++){
  if(i>=bytes.length)throw Error("truncated Wasm section length");
  const v=bytes[i++];
  if(j===4 && (v&0xf0))throw Error("invalid Wasm section length");
  value+=(v&127)*2**(7*j);
  if(!(v&128))return value;
 }throw Error("invalid Wasm LEB128 length")};
 while(i<bytes.length){
  const id=bytes[i++],length=u32(),end=i+length;
  if(end>bytes.length)throw Error("truncated linked Wasm module");
  if(id===8)throw Error("linked module has forbidden start section");
  i=end;
 }
}

async function rejectMixedPublication(published,publication){
 const conflicts=publication==="atomic"?
  [published,published+".artifact.json",published+".provenance.json"]:
  [published+".current.json",published+".releases"];
 for(const path of conflicts){
  try{
   await stat(path);
   throw Error("legacy and atomic artifact publications cannot share an output path");
  }catch(error){if(error.code!=="ENOENT")throw error}
 }
}
// Cooperating compiler processes serialize the actual publication boundary,
// not source compilation. An abandoned lock fails closed until cleaned by an
// operator; never steal a lock based on an untrusted pid/time claim.
async function withPublicationLock(published,publication,callback){
 const lock=published+".publication.lock";
 let acquired=false;
 for(let attempt=0;attempt<160;attempt++){
  try{await mkdir(lock,{mode:0o700});acquired=true;break}
  catch(error){
   if(error.code!=="EEXIST")throw error;
   await new Promise(resolve=>setTimeout(resolve,25));
  }
 }
 if(!acquired)throw Error("artifact publication lock unavailable");
 try{
  // This second admission check is serialized across cooperating compilers.
  await rejectMixedPublication(published,publication);
  return await callback();
 }finally{
  await rm(lock,{recursive:true,force:true});
 }
}
const absolute=(value,label)=>{if(!value||!isAbsolute(value))throw Error(label+" must be an absolute path");return value};
function run(command,args,{input}={}){
 const output=spawnSync(command,args,{input,encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024,windowsHide:true});
 if(output.error||output.status!==0||output.signal)throw Error("command failed ("+command+"): "+(output.error?.message||output.stderr||"exit "+output.status).slice(0,4000));
 return output.stdout||"";
}
export async function compileOresToWasm({compiler,source,output,exportName="main",clang=process.env.CLANG||"clang",compilerSha256,environment,publication="legacy"}){
 absolute(compiler,"compiler");
 absolute(source,"source");
 absolute(output,"output");
 // Resolve directory symlinks ONCE and use that physical pathname for
 // publication, not the caller's possibly aliased directory spelling.
 // A lexical resolve() comparison alone can overwrite compiler/source
 // inputs through an alternate symlinked parent directory.
 await mkdir(dirname(output),{recursive:true});
 const [sourcePath,compilerPath,outputParent]=await Promise.all([
  realpath(source),realpath(compiler),realpath(dirname(output))
 ]);
 const published=join(outputParent,basename(output));
 const protectedInputs=new Set([sourcePath,compilerPath]);
 if(!["atomic","legacy"].includes(publication))throw Error("invalid artifact publication mode");
 for(const destination of [published,published+".provenance.json",published+".artifact.json",published+".current.json",published+".releases",published+".publication.lock"]){
  if(protectedInputs.has(destination))
   throw Error("output or artifact metadata path overlaps a compiler/source input");
 }
 if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(exportName))throw Error("unsupported export name");
 // Preflight before readFile() to avoid allocating attacker-sized compiler
 // binaries or source buffers, then check the lengths again after reading.
 const [sourceStat,compilerStat]=await Promise.all([stat(sourcePath),stat(compilerPath)]);
 if(!sourceStat.isFile()||sourceStat.size>MAX_SOURCE_BYTES)
  throw Error("source exceeds 1 MiB compiler bridge budget or is not a regular file");
 if(!compilerStat.isFile()||compilerStat.size>MAX_COMPILER_BYTES)
  throw Error("compiler exceeds 256 MiB executable budget or is not a regular file");
 // A destination that already exists might itself be a symlink or hard link
 // to an input. Reject by inode identity before publishing over the link.
 // Merely canonicalizing its parent directory does not catch this case.
 for(const destination of [published,published+".provenance.json",published+".artifact.json",published+".current.json",published+".releases"]){
  try{
   const existing=await stat(destination);
   if([sourceStat,compilerStat].some(input=>
      input.dev===existing.dev&&input.ino===existing.ino))
    throw Error("output or artifact metadata path overlaps a compiler/source input");
  }catch(error){if(error?.code!=="ENOENT")throw error}
 }
 await rejectMixedPublication(published,publication);
 const [sourceSnapshot,compilerSnapshot]=await Promise.all([
  readBoundedRegularFile(sourcePath,MAX_SOURCE_BYTES,"source exceeds 1 MiB compiler bridge budget"),
  readBoundedRegularFile(compilerPath,MAX_COMPILER_BYTES,"compiler exceeds 256 MiB executable budget")
 ]);
 // Input paths may have changed after the initial preflight/inode overlap
 // checks. Refuse a different input inode rather than pinning a new source
 // through a validated destination alias.
 if(sourceSnapshot.stat.dev!==sourceStat.dev||sourceSnapshot.stat.ino!==sourceStat.ino||
    compilerSnapshot.stat.dev!==compilerStat.dev||compilerSnapshot.stat.ino!==compilerStat.ino)
  throw Error("compiler or source input changed between preflight and snapshot");
 const sourceBytes=sourceSnapshot.bytes,compilerBytes=compilerSnapshot.bytes;
 const actualCompilerHash=sha(compilerBytes);
 if(compilerSha256!==undefined&&compilerSha256!==actualCompilerHash)throw Error("compiler binary SHA-256 does not match pinned hash");
 if(environment!==undefined&&!["browser","edge-js","edge-wasi"].includes(environment))
  throw Error("unsupported portable host environment");
 // Compile exactly the already-hashed source snapshot, not a mutable path.
 // The current scalar subset supports standalone source files; relative
 // source imports must be resolved and pinned by a future module graph gate.
 const scratch=await mkdtemp(join(outputParent,".oreslang-wasm-"));
 const provisional=join(scratch,"guest.wasm");
 try{
 const stagedSource=join(scratch,"source.ores");
 const stagedCompiler=join(scratch,"compiler-exact");
 await writeFile(stagedSource,sourceBytes,{mode:0o400,flag:"wx"});
 // Execute the exact compiler bytes whose SHA-256 we pinned, not a mutable
 // caller-supplied pathname that may be replaced between hashing and exec.
 // The private scratch directory prevents pathname substitution by another
 // filesystem principal; this is not a sandbox for a malicious compiler.
 await writeFile(stagedCompiler,compilerBytes,{mode:0o500,flag:"wx"});
 // This is a Wasm compiler bridge in every publication mode. Never
 // accept host-targeted LLVM IR just because the linker targets wasm32.
 const ir=run(stagedCompiler,["--target=wasm32",stagedSource]);
 if(sha((await readBoundedRegularFile(stagedCompiler,MAX_COMPILER_BYTES,"staged compiler exceeds executable budget")).bytes)!==actualCompilerHash)
  throw Error("staged compiler executable changed during execution");
 // The executable itself is also caller-owned mutable input. Never publish
 // provenance tied to a compiler digest if its executable changed in flight.
 if(sha((await readBoundedRegularFile(compilerPath,MAX_COMPILER_BYTES,"compiler exceeds 256 MiB executable budget")).bytes)!==actualCompilerHash)
  throw Error("compiler executable changed during execution; refusing stale provenance");
 // Reject mutation of the snapshotted compilation input even when the
 // original caller path remains unchanged.
 if(sha((await readBoundedRegularFile(stagedSource,MAX_SOURCE_BYTES,"staged source exceeds source budget")).bytes)!==sha(sourceBytes))
  throw Error("staged compiler input changed during execution");
 // Require a genuine LLVM triple declaration, not a comment or string.
 // Ensure an actual target triple exists, not a comment, duplicate, or
 // native-target fallback masquerading as wasm32.
 assertWasm32IrTarget(ir);
 if(!new RegExp("define\\s+i64\\s+@"+exportName+"\\s*\\(\\s*\\)").test(ir))throw Error("compiler did not emit the expected i64 @"+exportName+"() export");
 if(ir.length>2*1024*1024)throw Error("generated IR exceeds 2 MiB");
 // Avoid shell expansion and avoid relying on persistent temporary LLVM IR.
 // Clang reads the native compiler's verified stdout as LLVM IR.
 run(clang,["--target=wasm32","-x","ir","-Oz","-nostdlib",
   "-Wl,--no-entry","-Wl,--export="+exportName,
   "-Wl,--initial-memory=131072","-Wl,--max-memory=131072",
   "-o",provisional,"-"],{input:ir});
 const wasm=(await readBoundedRegularFile(provisional,MAX_WASM_BYTES,
  "linked Wasm exceeds 16 MiB artifact budget")).bytes;
 if(!WebAssembly.validate(wasm))throw Error("linker emitted invalid core Wasm");
 rejectStartSection(wasm);
 const module=new WebAssembly.Module(wasm);
 const imports=WebAssembly.Module.imports(module);
 if(imports.length)throw Error("guest Wasm unexpectedly imports host modules: "+imports.map(x=>x.module+"."+x.name).join(","));
 const guestExports=WebAssembly.Module.exports(module);
 if(!guestExports.some(x=>x.name===exportName&&x.kind==="function"))throw Error("guest Wasm missing requested export");
 if(!guestExports.some(x=>x.name==="memory"&&x.kind==="memory"))throw Error("guest Wasm missing required bounded memory export");
 assertCoreI64Entry(wasm,exportName);
 // The artifact manifest advertises an exact 2-page memory maximum. Check
 // the binary rather than relying on Clang flags or its version string.
 const memory=inspectWasmBytes(wasm,{maxModuleBytes:MAX_WASM_BYTES,maxMemoryPages:2});
 if(memory.memoryCount!==1||!memory.hasMemoryMaximum||memory.memoryMaximum!==2)
  throw Error("linked Wasm memory must declare exactly one bounded 2-page memory");
 const record={
  schemaVersion:1,kind:"llvm-ores-to-wasm32-core-experimental",
  compilerSha256:actualCompilerHash,sourceSha256:sha(sourceBytes),
  llvmIrSha256:sha(Buffer.from(ir,"utf8")),wasmSha256:sha(wasm),
  exportName,importCount:imports.length,wasmBytes:wasm.length,
  clangVersion:run(clang,["--version"]).split("\n")[0],
  note:"Binary provenance: exact compiler executable bytes, not proof of source-repository commit or feature parity."
 };
 let manifest=null;
 if(environment){
  manifest={
   schemaVersion:1,artifactType:"oreslang.core-wasm.i64-v1",
   target:"wasm32",environment,backend:"wasm",entry:exportName,
   wasmSha256:sha(wasm),wasmBytes:wasm.length,requiredCapabilities:[],
   imports:[],memory:{maximumPages:2},
   producer:{compilerSha256:actualCompilerHash,
     sourceSha256:sha(sourceBytes),llvmIrSha256:sha(Buffer.from(ir,"utf8"))}
  };
  await writeFile(join(scratch,"artifact.json"),JSON.stringify(manifest,null,2)+"\n");
 }
 await writeFile(join(scratch,"provenance.json"),JSON.stringify(record,null,2)+"\n");
 return await withPublicationLock(published,publication,async()=>{
 if(publication==="atomic"){
  // The content-addressed release is privately staged and sealed first.
  // Only a single pointer rename makes it visible to verified readers.
  const publishedRelease=await publishAtomicRelease({
   output:published,wasm,manifest,provenance:record
  });
  return {...record,releaseSha256:publishedRelease.releaseSha256,
   publication:"atomic",pointer:publishedRelease.pointer};
 }
 // Publish metadata first; never expose a new executable after metadata
 // publication failed. Consumers must still SHA-check all sidecars: separate
 // files cannot be atomically committed as one transaction.
 if(environment)await rename(join(scratch,"artifact.json"),published+".artifact.json");
 await rename(join(scratch,"provenance.json"),published+".provenance.json");
 await rename(provisional,published);
 return record;
 });
 }finally{await rm(scratch,{recursive:true,force:true})}
}
const calledFromCli=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(calledFromCli){
 try{
  const usedOptions=new Set();
  const options=Object.fromEntries(process.argv.slice(2).map(x=>{
   const m=/^--(compiler|source|output|export|clang|compiler-sha256|environment|publication)=(.*)$/.exec(x);
   if(!m)throw Error("unexpected CLI option: "+x);
   if(usedOptions.has(m[1]))throw Error("duplicate CLI option: "+m[1]);
   usedOptions.add(m[1]);
   return[m[1],m[2]];
  }));
  const record=await compileOresToWasm({
   compiler:options.compiler,source:options.source,
   output:options.output||resolve(projectRoot,"build/guest.wasm"),
   exportName:options.export||"main",clang:options.clang||process.env.CLANG||"clang",
   compilerSha256:options["compiler-sha256"],environment:options.environment,publication:options.publication||"legacy"
  });
  console.log(JSON.stringify(record,null,2));
 }catch(error){console.error(error.stack||error.message);process.exitCode=1}
}
