#[path="../../profile.rs"] mod profile;
use std::{env,fs::{self,OpenOptions},io::{Read,Write}};
use sha2::{Digest,Sha256};
use wasmtime::Module;
const MAX_WASM:u64=16*1024*1024;
const MAX_AOT:usize=128*1024*1024;
fn main()->Result<(),Box<dyn std::error::Error>>{
 let args=env::args().skip(1).collect::<Vec<_>>();
 if args.len()!=2{return Err("usage: precompile VERIFIED.wasm NEW.cwasm".into());}
 let f=fs::File::open(&args[0])?;
 if !f.metadata()?.is_file(){return Err("expected regular Wasm file".into());}
 let mut wasm=Vec::new();
 f.take(MAX_WASM+1).read_to_end(&mut wasm)?;
 if wasm.len() as u64>MAX_WASM{return Err("Wasm input too large".into());}
 let engine=profile::engine()?;
 let module=Module::from_binary(&engine,&wasm)?;
 profile::check_abi(&module)?;
 let aot=engine.precompile_module(&wasm)?;
 if aot.len()>MAX_AOT{return Err("native artifact too large".into());}
 let mut out=OpenOptions::new().create_new(true).write(true).open(&args[1])?;
 out.write_all(&aot)?;out.sync_all()?;
 println!("wasm_sha256={:x}",Sha256::digest(&wasm));
 println!("aot_sha256={:x}",Sha256::digest(&aot));
 Ok(())
}
