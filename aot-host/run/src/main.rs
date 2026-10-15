#[path="../../profile.rs"] mod profile;
use std::{env,fs,io::Read};
use sha2::{Digest,Sha256};
use wasmtime::{Instance,Module,Store};
const MAX_AOT:u64=128*1024*1024;
fn main()->Result<(),Box<dyn std::error::Error>>{
 let args=env::args().skip(1).collect::<Vec<_>>();
 if args.len()!=2{return Err("usage: run-aot APPROVED.cwasm TRUSTED_DEPLOYMENT_SHA256".into());}
 let pin=&args[1];
 if pin.len()!=64||!pin.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){
  return Err("trusted SHA-256 must be exactly 64 lowercase hex digits".into());
 }
 let f=fs::File::open(&args[0])?;
 if !f.metadata()?.is_file(){return Err("expected regular AOT file".into());}
 let mut bytes=Vec::new();
 f.take(MAX_AOT+1).read_to_end(&mut bytes)?;
 if bytes.len() as u64>MAX_AOT{return Err("native artifact exceeds budget".into());}
 if format!("{:x}",Sha256::digest(&bytes))!=*pin{
  return Err("AOT bytes do not match trusted deployment pin".into());
 }
 let engine=profile::engine()?;
 // SAFETY: The digest MUST originate from an authenticated operator-managed
 // deployment channel and match a trusted Wasmtime-produced artifact.
 // A guest-supplied pin or self-reported manifest is never sufficient.
 let module=unsafe{Module::deserialize(&engine,&bytes)?};
 profile::check_abi(&module)?;
 let mut store=Store::new(&engine,());
 store.set_fuel(1_000_000)?;
 let instance=Instance::new(&mut store,&module,&[])?;
 let f=instance.get_typed_func::<(),i64>(&mut store,"main")?;
 println!("{}",f.call(&mut store,())?);
 Ok(())
}
