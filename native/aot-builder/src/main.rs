//! Trusted AOT build executable, not an actor-facing API.
use sha2::{Digest, Sha256};
use std::{env, error::Error, fs::{File, OpenOptions}, io::{Read, Write}};
use wasmtime::{Config,Engine,Module};
fn denied(msg:&'static str)->Box<dyn Error>{msg.into()}
fn sha(b:&[u8])->String{format!("{:x}",Sha256::digest(b))}
fn valid_hash(s:&str)->bool{s.len()==64&&s.bytes().all(|b|b.is_ascii_digit()||(b'a'..=b'f').contains(&b))}
fn bounded(path:&str, max:usize)->Result<Vec<u8>,Box<dyn Error>>{
 let mut f=File::open(path)?; let metadata=f.metadata()?;
 if !metadata.is_file()||metadata.len()>max as u64{return Err(denied("file exceeds source byte budget"))}
 let mut bytes=Vec::new();
 f.by_ref().take((max+1) as u64).read_to_end(&mut bytes)?;
 if bytes.len()>max||bytes.len() as u64!=metadata.len(){return Err(denied("input size changed"))}
 Ok(bytes)
}
fn leb(b:&[u8],pos:&mut usize,end:usize)->Result<u32,Box<dyn Error>>{
 let mut n=0u32;
 for shift in [0,7,14,21,28] {
  if *pos>=end{return Err(denied("truncated LEB128"))}
  let v=b[*pos];*pos+=1;
  if shift==28&&v&0xf0!=0{return Err(denied("invalid LEB128"))}
  n|=((v&127) as u32)<<shift;
  if v&128==0{return Ok(n)}
 }
 Err(denied("overlong LEB128"))
}
fn profile(b:&[u8])->Result<(),Box<dyn Error>>{
 if b.len()<8||&b[..8]!=b"\0asm\x01\0\0\0"{return Err(denied("bad core wasm header"))}
 let mut pos=8;let mut memories=0;
 while pos<b.len(){
  let id=b[pos];pos+=1;
  let len=leb(b,&mut pos,b.len())? as usize;
  let end=pos.checked_add(len).filter(|p|*p<=b.len()).ok_or_else(||denied("invalid wasm section length"))?;
  if matches!(id,2|4|8){return Err(denied("imports, tables and start section denied"))}
  if id==5 {
   if leb(b,&mut pos,end)?!=1{return Err(denied("exactly one defined memory required"))}
   if leb(b,&mut pos,end)?!=1{return Err(denied("unbounded, shared, memory64 denied"))}
   let min=leb(b,&mut pos,end)?;let max=leb(b,&mut pos,end)?;
   if min>max||max!=2||pos!=end{return Err(denied("exact two-page memory max required"))}
   memories+=1;
  }
  pos=end;
 }
 if memories!=1{return Err(denied("one memory required"))}
 Ok(())
}
fn run()->Result<(),Box<dyn Error>>{
 let a:Vec<String>=env::args().collect();
 if a.len()!=4{return Err(denied("usage: aot-build SOURCE_WASM PINNED_SOURCE_SHA OUTPUT_CWASM"))}
 if !valid_hash(&a[2]){return Err(denied("invalid source digest pin"))}
 let bytes=bounded(&a[1],16*1024*1024)?;
 if sha(&bytes)!=a[2]{return Err(denied("source wasm digest mismatch"))}
 profile(&bytes)?;
 let mut cfg=Config::new();
 cfg.consume_fuel(true).wasm_memory64(false).wasm_multi_memory(false);
 let engine=Engine::new(&cfg)?;
 Module::validate(&engine,&bytes)?;
 let m=Module::new(&engine,&bytes)?;
 if m.imports().next().is_some(){return Err(denied("host imports denied"))}
 let mut has_main=false;
 for e in m.exports(){if e.name()=="main"{has_main=true}else if e.name()!="memory"{return Err(denied("unexpected export"))}}
 if !has_main{return Err(denied("missing main"))}
 let code=engine.precompile_module(&bytes)?;
 if code.len()>64*1024*1024{return Err(denied("AOT artifact exceeds budget"))}
 // Refuse overwrite of an existing compiled release artifact.
 let mut out=OpenOptions::new().create_new(true).write(true).open(&a[3])?;
 out.write_all(&code)?;out.sync_all()?;
 println!("aot_sha256={}",sha(&code));
 println!("wasm_sha256={}",sha(&bytes));
 Ok(())
}
fn main(){if let Err(e)=run(){eprintln!("trusted AOT builder refused: {e}");std::process::exit(1)}}
