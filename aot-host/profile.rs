use wasmtime::{Config,Engine,ExternType,Module,ValType};
pub fn engine() -> Result<Engine,Box<dyn std::error::Error>> {
 let mut config=Config::new();
 config.consume_fuel(true);
 config.wasm_multi_memory(false);
 config.wasm_memory64(false);
 Ok(Engine::new(&config)?)
}
pub fn check_abi(m:&Module)->Result<(),Box<dyn std::error::Error>> {
 if m.imports().next().is_some(){return Err("host imports denied".into());}
 let mut entry=0usize;let mut memories=0usize;
 for ex in m.exports(){
  match (ex.name(),ex.ty()){
   ("main",ExternType::Func(f))=>{
    let mut result_types=f.results();
    if f.params().count()!=0 || !matches!(result_types.next(),Some(ValType::I64)) || result_types.next().is_some(){
     return Err("main must have exact () -> i64 signature".into());
    }entry+=1;
   }
   ("memory",ExternType::Memory(mem))=>{
    if mem.is_shared()||mem.is_64()||mem.maximum()!=Some(2)||mem.minimum()>2{
     return Err("private wasm32 memory must have bounded two-page maximum".into());
    }memories+=1;
   }
   _=>return Err("unexpected Wasm export".into())
  }
 }
 if entry!=1||memories!=1{return Err("guest must export main and memory once".into());}
 Ok(())
}

#[cfg(test)]
mod fuel_admission_tests {
 use super::engine;
 use wasmtime::Store;

 #[test]
 fn hard_fuel_is_enabled_and_isolated_per_wasmtime_store() {
  // A mutation removing consume_fuel(true) causes set_fuel to fail. This
  // protects the independent hard trap while guest 128-edge polling matures.
  let engine=engine().expect("fuel-enabled engine");
  let mut offender=Store::new(&engine,());
  let mut healthy=Store::new(&engine,());
  offender.set_fuel(128).expect("hard fuel must be enabled");
  healthy.set_fuel(512).expect("independent hard fuel");
  assert_eq!(offender.get_fuel().unwrap(),128);
  assert_eq!(healthy.get_fuel().unwrap(),512);
  offender.set_fuel(0).unwrap();
  assert_eq!(offender.get_fuel().unwrap(),0);
  assert_eq!(healthy.get_fuel().unwrap(),512,
    "one tenant's fuel exhaustion must not mutate a sibling Store");
 }
}
