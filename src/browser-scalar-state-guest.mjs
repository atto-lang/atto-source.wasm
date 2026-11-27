// Opt-in trusted-compiler scalar state profile. No change to general tenant
// admission: state imports are not authorization for arbitrary Wasm bytes.
import {createCompiler, verifyCompilerBytes} from './canonical-browser-compiler.mjs';
import {createStateRuntime,runScalarStateTurn} from './browser-scalar-state-runtime.mjs';
import {fixed_memory_pages, actor_names} from './wasm-profile.mjs';
import {assertCoreI64Entry} from '../scripts/core-i64-abi.mjs';

export async function runVerifiedScalarStateSource({compilerBytes, compilerSha256, compilerLength, source}) {
  // Caller must independently trust the pinned compiler build receipt.
  if (!(compilerBytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/.test(compilerSha256)
      || !Number.isSafeInteger(compilerLength) || compilerLength < 8 || compilerLength > 64*1024*1024)
    throw new TypeError('E_COMPILER_PIN: exact trusted compiler identity required');
  const bytes = Uint8Array.from(compilerBytes);
  await verifyCompilerBytes(bytes, compilerSha256, compilerLength);
  const compiler = await createCompiler(bytes);
  const compiled = compiler.compile(source);
  if (!compiled.ok) return {ok:false, phase:'compile', diagnostics:compiled.diagnostics};
  const wasm = compiled.wasm;
  const pages = fixed_memory_pages(wasm);
  assertCoreI64Entry(wasm,'main');
  const module = new WebAssembly.Module(wasm);
  const allowed = new Set(['print_i64','print_bool','print_newline','state_register','state_enter','state_leave']);
  if (actor_names(module).length || !pages ||
      WebAssembly.Module.exports(module).some(x=>!['main','memory','panic_code'].includes(x.name)) ||
      WebAssembly.Module.imports(module).some(x=>x.module!=='atto'||x.kind!=='function'||!allowed.has(x.name)))
    throw new Error('E_STATE_PROFILE: scalar-only compiler guest required');
  const events=[]; let stdout='', instance;
  const runtime=createStateRuntime({onEvent:e=>{if(events.length<4096)events.push(e);}});
  function write(s) {
    if(runtime.snapshot().active)throw new Error('E_STATE_PUBLICATION: output while lease is active');
    if(stdout.length+s.length>65536)throw new Error('E_OUTPUT_LIMIT');
    stdout+=s;
  }
  try {
    const value=runScalarStateTurn(runtime,()=>{
      instance=new WebAssembly.Instance(module,{atto:{...runtime.imports,
        print_i64:n=>write(String(n)),print_bool:n=>write(n?'true':'false'),
        print_newline:()=>write('\n')}});
      const value=instance.exports.main();
      if(typeof value!=='bigint')throw new Error('E_ABI: i64 expected');
      return value;
    });
    return {ok:true,phase:'guest',value:String(value),stdout,state:runtime.snapshot(),events};
  } catch(error) {
    // Physical synchronous unwind has occurred. Retire entire execution;
    // never pretend to recover or roll back writes after a fatal guest trap.
    return {ok:false,phase:'guest',panic:instance?.exports.panic_code?.value??null,
      message:String(error?.message??error),stdout,state:runtime.snapshot(),events};
  }
}
