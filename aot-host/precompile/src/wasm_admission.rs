//! Precompile-only strict raw Wasm admission. The runtime never parses or
//! compiles untrusted Wasm and must not depend on wasmparser.
use wasmparser::{Encoding,Parser,Payload,Validator,WasmFeatures};
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
 // Parser-level section filtering alone is not sufficient: otherwise a
 // type, global or function body can carry managed references or Wasm-GC
 // instructions even when it has no table, imports, or start section.
 // Use the exact same immutable snapshot that will be compiled by Wasmtime.
 let mut features=WasmFeatures::default();
 features.remove(
  WasmFeatures::GC |
  WasmFeatures::GC_TYPES |
  WasmFeatures::REFERENCE_TYPES |
  WasmFeatures::FUNCTION_REFERENCES |
  WasmFeatures::SIMD |
  WasmFeatures::RELAXED_SIMD |
  WasmFeatures::TAIL_CALL |
  WasmFeatures::THREADS |
  WasmFeatures::EXCEPTIONS |
  WasmFeatures::MEMORY64 |
  WasmFeatures::MULTI_MEMORY
 );
 Validator::new_with_features(features).validate_all(wasm)?;
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

 #[test]
 fn strict_aot_rejects_valid_externref_function_types(){
  // A valid core module carrying an otherwise unused externref parameter.
  // Default wasmparser validation allows it; the sealed zero-GC profile does not.
  let wasm=[
   0,97,115,109,1,0,0,0,
   1,5,1,0x60,1,0x6f,0,
   5,4,1,1,1,2,
  ];
  assert!(Validator::new().validate_all(&wasm).is_ok());
  assert!(validate_scalar_module(&wasm).is_err());
 }
 #[test]
 fn strict_aot_rejects_valid_gc_struct_types(){
  // One unused empty struct definition (GC type opcode 0x5f), plus
  // otherwise allowed fixed private wasm32 memory.
  let wasm=[
   0,97,115,109,1,0,0,0,
   1,3,1,0x5f,0,
   5,4,1,1,1,2,
  ];
  assert!(Validator::new().validate_all(&wasm).is_ok());
  assert!(validate_scalar_module(&wasm).is_err());
 }
 #[test]
 fn strict_aot_rejects_reference_instruction_even_without_exports(){
  // Valid function: ref.null extern; drop; end. There is no table or
  // externref export; scanning sections by kind would miss the operation.
  let wasm=[
   0,97,115,109,1,0,0,0,
   1,4,1,0x60,0,0,
   3,2,1,0,
   5,4,1,1,1,2,
   10,7,1,5,0,0xd0,0x6f,0x1a,0x0b,
  ];
  assert!(Validator::new().validate_all(&wasm).is_ok());
  assert!(validate_scalar_module(&wasm).is_err());
 }


 #[test]
 fn strict_scalar_profile_rejects_valid_simd_function_body(){
  // Valid zero-import module with private memory and unused v128.const.
  // SIMD code never belongs in core-wasm.i64-v1 without a new profile.
  let mut wasm=vec![
   0,97,115,109,1,0,0,0,
   1,5,1,0x60,0,1,0x7e,
   3,2,1,0,
   5,4,1,1,1,2,
   7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0,
   10,26,1,23,0,0xfd,0x0c
  ];
  wasm.extend_from_slice(&[0;16]); // v128.const immediate
  wasm.extend_from_slice(&[0x1a,0x42,42,0x0b]); // drop; i64.const 42; end
  assert!(Validator::new().validate_all(&wasm).is_ok());
  assert!(validate_scalar_module(&wasm).is_err());
 }
 #[test]
 fn strict_scalar_profile_rejects_valid_tail_call_body(){
  // Valid main() returning 42 via return_call helper(). Node scalar
  // admission rejects opcode 0x12; strict native precompile must agree.
  let wasm=[
   0,97,115,109,1,0,0,0,
   1,5,1,0x60,0,1,0x7e,
   3,3,2,0,0,
   5,4,1,1,1,2,
   7,17,2,4,109,97,105,110,0,0,6,109,101,109,111,114,121,2,0,
   10,11,2,4,0,0x12,1,0x0b,4,0,0x42,42,0x0b
  ];
  assert!(Validator::new().validate_all(&wasm).is_ok());
  assert!(validate_scalar_module(&wasm).is_err());
 }

}
