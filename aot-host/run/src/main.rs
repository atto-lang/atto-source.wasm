#[path="../../profile.rs"] mod profile;
#[path="../../io.rs"] mod io;
use std::env;
use sha2::{Digest,Sha256};
use wasmtime::{Engine,Instance,Module,Precompiled,Store,StoreLimitsBuilder};
const MAX_AOT:u64=128*1024*1024;
// A digest passed on the command line is NOT a trust anchor: a hostile caller
// can choose both executable bytes and their hash. Prevent shipping this
// prototype execution path as a release/production binary. Replace the
// release gate only after an independently authenticated deployment approval
// and an OS-isolated process supervisor are implemented.
#[cfg(not(all(debug_assertions, feature = "insecure-dev-caller-pin")))]
fn main()->Result<(),Box<dyn std::error::Error>>{
 Err("AOT execution is disabled unless a debug build explicitly enables insecure-dev-caller-pin; authenticated artifact approval and OS isolation are not implemented".into())
}

// This deliberately insecure caller-pin interface requires BOTH a debug
// build AND an explicit insecure-dev-caller-pin Cargo feature. No execution
// path is compiled into the ordinary debug or any ordinary release binary.
#[cfg(all(debug_assertions, feature = "insecure-dev-caller-pin"))]
fn main()->Result<(),Box<dyn std::error::Error>>{
 let args=env::args().skip(1).collect::<Vec<_>>();
 if args.len()!=2 && args.len()!=3{
  return Err("usage (insecure debug only): run-aot LOCAL.cwasm INSECURE_DEV_SHA256 [FUEL]".into());
 }
 let fuel=match args.get(2){
  Some(n)=>n.parse::<u64>()?,
  None=>1_000_000
 };
 if !(1..=100_000_000).contains(&fuel){
  return Err("fuel must be between 1 and 100000000".into());
 }
 let pin=&args[1];
 if pin.len()!=64||!pin.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b)){
  return Err("insecure development SHA-256 must be exactly 64 lowercase hex digits".into());
 }
 let bytes=io::bounded_regular_file(&args[0],MAX_AOT)?;
 if format!("{:x}",Sha256::digest(&bytes))!=*pin{
  return Err("AOT bytes do not match insecure development digest".into());
 }
 // This is only format discrimination, NOT security validation.
 // Refuse raw Wasm and native components even when a caller supplies the
 // correct content hash. It must happen BEFORE unsafe deserialization.
 if !matches!(Engine::detect_precompiled(&bytes),Some(Precompiled::Module)){
  return Err("approved bytes are not a precompiled core Wasm module".into());
 }
 let engine=profile::engine()?;
 // SAFETY: The digest MUST originate from an authenticated operator-managed
 // deployment channel and match a trusted Wasmtime-produced artifact.
 // A guest-supplied pin or self-reported manifest is never sufficient.
 let module=unsafe{Module::deserialize(&engine,&bytes)?};
 profile::check_abi(&module)?;
 let limits=StoreLimitsBuilder::new()
  .memory_size(131072).memories(1).tables(0).instances(1).build();
 let mut store=Store::new(&engine,limits);
 store.limiter(|limits|limits);
 store.set_fuel(fuel)?;
 let instance=Instance::new(&mut store,&module,&[])?;
 let f=instance.get_typed_func::<(),i64>(&mut store,"main")?;
 println!("{}",f.call(&mut store,())?);
 Ok(())
}
