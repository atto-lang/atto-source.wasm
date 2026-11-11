//! Precompile-only strict raw Wasm admission. The runtime never parses or
//! compiles untrusted Wasm and must not depend on wasmparser.
use wasmparser::{Encoding,Parser,Payload};
use std::error::Error;
pub fn validate_scalar_module(wasm:&[u8])->Result<(),Box<dyn Error>>{
 let mut memory_sections=0usize;
 let mut memories=0usize;
 for payload in Parser::new(0).parse_all(wasm){
  match payload?{
   Payload::Version{encoding,..}=>{
    if !matches!(encoding,Encoding::Module){
     return Err("components are not admitted in scalar profile".into());
    }
   }
   Payload::ImportSection(_)=>return Err("guest imports are forbidden".into()),
   Payload::StartSection{..}=>return Err("guest start sections are forbidden".into()),
   Payload::TableSection(_)=>return Err("guest tables are forbidden".into()),
   Payload::ElementSection(_)=>return Err("guest element sections are forbidden".into()),
   Payload::TagSection(_)=>return Err("guest tags are forbidden".into()),
   Payload::UnknownSection{..}=>return Err("unknown Wasm sections are forbidden".into()),
   Payload::MemorySection(reader)=>{
    memory_sections+=1;
    if memory_sections!=1 || reader.count()!=1{
     return Err("exactly one private declared memory is required".into());
    }
    for parsed in reader{
     let memory=parsed?;
     if memory.memory64 || memory.shared || memory.page_size_log2.is_some() ||
       memory.initial>2 || memory.maximum!=Some(2){
      return Err("memory must be ordinary private wasm32 with a two-page maximum".into());
     }
     memories+=1;
    }
   }
   _=>{}
  }
 }
 if memory_sections!=1 || memories!=1{
  return Err("exactly one declared memory is required".into());
 }
 Ok(())
}
#[cfg(test)]
mod tests{
 use super::*;
 #[test]
 fn invalid_module_and_no_memory_fail_closed(){
  assert!(validate_scalar_module(&[0,97,115,109,1,0,0,0]).is_err());
  assert!(validate_scalar_module(&[1,2,3]).is_err());
 }
 #[test]
 fn reject_start_table_and_hidden_memory(){
  // One otherwise well-formed (but empty) Wasm memory section declares a
  // private 1..2 memory; type/code/function sections are not needed for this
  // raw admission precheck.
  let memory=&[0,97,115,109,1,0,0,0,5,4,1,1,1,2][..];
  assert!(validate_scalar_module(memory).is_ok());
  let mut with_table=memory.to_vec();
  // A table section even with zero entries is unsupported.
  with_table.extend_from_slice(&[4,1,0]);
  assert!(validate_scalar_module(&with_table).is_err());
  let mut with_start=memory.to_vec();
  with_start.extend_from_slice(&[8,1,0]);
  assert!(validate_scalar_module(&with_start).is_err());
  // A memory-section with 2 memories is rejected before executable codegen.
  let two=[0,97,115,109,1,0,0,0,5,7,2,1,1,2,1,1,2];
  assert!(validate_scalar_module(&two).is_err());
 }
}
