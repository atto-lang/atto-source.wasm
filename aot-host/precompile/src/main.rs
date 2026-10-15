#[path="../../profile.rs"] mod profile;
#[path="../../io.rs"] mod io;
mod wasm_admission;
use std::{env,fs::OpenOptions,io::Write};
use sha2::{Digest,Sha256};
use wasmtime::Module;
const MAX_WASM:u64=16*1024*1024;
const MAX_AOT:usize=128*1024*1024;
fn main()->Result<(),Box<dyn std::error::Error>>{
 let args=env::args().skip(1).collect::<Vec<_>>();
 if args.len()!=2{return Err("usage: precompile VERIFIED.wasm NEW.cwasm".into());}
 let wasm=io::bounded_regular_file(&args[0],MAX_WASM)?;
 // Validate the raw byte-level admission profile before *any* expensive
 // native-code generation. Wasmtime exported ABI introspection alone does not
 // show hidden tables, start functions or unexported extra memories.
 wasm_admission::validate_scalar_module(&wasm)?;
 let engine=profile::engine()?;
 let module=Module::from_binary(&engine,&wasm)?;
 profile::check_abi(&module)?;
 // Serialize the module we already compiled, avoiding a second translation
 // and code generation pass through Engine::precompile_module.
 let aot=module.serialize()?;
 if aot.len()>MAX_AOT{return Err("native artifact too large".into());}
 let mut out=OpenOptions::new().create_new(true).write(true).open(&args[1])?;
 out.write_all(&aot)?;out.sync_all()?;
 println!("wasm_sha256={:x}",Sha256::digest(&wasm));
 println!("aot_sha256={:x}",Sha256::digest(&aot));
 Ok(())
}
