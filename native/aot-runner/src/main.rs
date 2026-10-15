//! Compiler-free Wasmtime guest executor. Use inside a dedicated OS sandbox.
//! The trusted AOT digest must originate from an independently authenticated
//! deployment record, never from arbitrary user input.
use sha2::{Digest,Sha256};
use std::{env,error::Error,fs::File,io::Read};
use wasmtime::{Config,Engine,ExternType,Instance,Module,Store,StoreLimitsBuilder};
fn denied(msg:&'static str)->Box<dyn Error>{msg.into()}
fn sha(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
fn valid_pin(s:&str)->bool{s.len()==64&&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn bounded(path:&str)->Result<Vec<u8>,Box<dyn Error>>{
 let mut f=File::open(path)?;let m=f.metadata()?;
 if !m.is_file()||m.len()>64*1024*1024{return Err(denied("invalid AOT artifact size"))}
 let mut bytes=Vec::new();
 f.by_ref().take(64*1024*1024+1).read_to_end(&mut bytes)?;
 if bytes.len()>64*1024*1024||bytes.len() as u64!=m.len(){return Err(denied("native artifact changed size"))}
 Ok(bytes)
}
fn run()->Result<(),Box<dyn Error>>{
 let args:Vec<String>=env::args().collect();
 if args.len()!=4{return Err(denied("usage: aot-run TRUSTED_CWASM APPROVED_AOT_SHA FUEL"))}
 if !valid_pin(&args[2]){return Err(denied("invalid trusted AOT digest"))}
 let fuel=args[3].parse::<u64>()?;
 if fuel==0||fuel>100_000_000{return Err(denied("fuel outside permitted range"))}
 let code=bounded(&args[1])?;
 if sha(&code)!=args[2]{return Err(denied("native AOT digest mismatch"))}
 let mut cfg=Config::new();
 cfg.consume_fuel(true).wasm_memory64(false).wasm_multi_memory(false);
 let engine=Engine::new(&cfg)?;
 // SAFETY: Engine::precompile_module generated these exact trusted bytes and
 // an independently approved SHA pin authenticated them. Malicious native
 // blobs remain UNSAFE even when hashed; a submitter-supplied SHA is not trust.
 let module=unsafe{Module::deserialize(&engine,&code)?};
 if module.imports().next().is_some(){return Err(denied("guest imports forbidden"))}
 let mut main=false;
 for e in module.exports(){
  match (e.name(),e.ty()){
   ("main",ExternType::Func(_))=>main=true,
   ("memory",ExternType::Memory(_))=>{},
   _=>return Err(denied("unexpected guest export"))
  }
 }
 if !main{return Err(denied("no main export"))}
 let limits=StoreLimitsBuilder::new().memory_size(131072).memories(1).tables(0).instances(1).build();
 let mut store=Store::new(&engine,limits);
 store.limiter(|s|s);
 store.set_fuel(fuel)?;
 let instance=Instance::new(&mut store,&module,&[])?;
 let entry=instance.get_typed_func::<(),i64>(&mut store,"main")?;
 let result=entry.call(&mut store,())?;
 println!("result_i64={result}");
 println!("aot_sha256={}",args[2]);
 println!("fuel_remaining={}",store.get_fuel()?);
 Ok(())
}
fn main(){if let Err(e)=run(){eprintln!("trusted AOT runner refused: {e}");std::process::exit(1)}}
