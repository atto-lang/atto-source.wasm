#[path="../../profile.rs"] mod profile;
#[path="../../io.rs"] mod io;
mod wasm_admission;
mod publish;
use std::env;
use sha2::{Digest,Sha256};
use wasmtime::Module;
const MAX_WASM:u64=16*1024*1024;
const MAX_AOT:usize=128*1024*1024;
fn main()->Result<(),Box<dyn std::error::Error>>{
 let args=env::args().skip(1).collect::<Vec<_>>();
 if args.len()!=3{return Err("usage: precompile VERIFIED.wasm APPROVED_WASM_SHA256 NEW.cwasm".into());}
 let approved=&args[1];
 if approved.len()!=64 || !approved.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){
  return Err("approved input SHA-256 must be exactly 64 lowercase hex digits".into());
 }
 let wasm=io::bounded_regular_file(&args[0],MAX_WASM)?;
 if format!("{:x}",Sha256::digest(&wasm))!=*approved{
  return Err("verified Wasm bytes do not match approved source SHA-256".into());
 }
 // Validate the raw byte-level admission profile before *any* expensive
 // native-code generation. Wasmtime exported ABI introspection alone does not
 // show hidden tables, start functions or unexported extra memories.
 wasm_admission::validate_scalar_module(&wasm)?;
 let engine=profile::engine()?;
 let module=Module::from_binary(&engine,&wasm)?;
 profile::check_abi(&module)?;
 // Serialize the module we already compiled, avoiding a second translation
 // and code generation pass through Engine::precompile_module.
 // FULL_GUEST_AOT_TODO (platform-conformance #321): module.serialize()
 // produces a Wasmtime precompiled artifact for an already-supplied Wasm
 // module, not proof that arbitrary .atto source was statically lowered.
 // This artifact is host/architecture/engine-version specific; browser
 // WebAssembly + Web Workers cannot load Wasmtime serialized .cwasm.
 // Close source callbacks, imports, actor message ABI and ownership/drop
 // graph before treating a bundle as a complete guest AOT release.
 // ZERO_TRACING_GC_TODO: Reject Wasm-GC/reference-managed guest imports
 // in the sealed lane and verify private linear-memory actor arenas with
 // checked 32-bit offsets, generations, bounds and deterministic reclamation
 // across cancellation, tenant-worker termination, restart and hot load.
 // Existing Wasmtime precompile and ordinary runtime paths remain intact.
 let aot=module.serialize()?;
 if aot.len()>MAX_AOT{return Err("native artifact too large".into());}
 // Stage and sync full native code before it becomes visible at the
 // final release pathname. Never overwrite an already-published artifact.
 publish::publish_no_clobber(&args[2], &aot)?;
 println!("wasm_sha256={:x}",Sha256::digest(&wasm));
 println!("aot_sha256={:x}",Sha256::digest(&aot));
 Ok(())
}
