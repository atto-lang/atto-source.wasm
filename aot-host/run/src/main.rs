#[path="../../profile.rs"] mod profile;
#[path="../../io.rs"] mod io;
mod tenant_isolation;
use std::env;
use sha2::{Digest,Sha256};
use wasmtime::{Engine,Instance,Module,Precompiled,Store,StoreLimitsBuilder};
const MAX_AOT:u64=128*1024*1024;
// A digest passed on the command line is NOT a trust anchor: a hostile caller
// can choose both executable bytes and their hash. Prevent shipping this
// prototype execution path as a release/production binary. Replace the
// release gate only after an independently authenticated deployment approval
// and an OS-isolated process supervisor are implemented.
#[cfg(not(all(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin")))]
fn main()->Result<(),Box<dyn std::error::Error>>{
 Err("AOT execution is disabled unless the Cargo debug profile explicitly enables insecure-dev-caller-pin; authenticated artifact approval and OS isolation are not implemented".into())
}

// This deliberately insecure caller-pin interface requires BOTH a debug
// build AND an explicit insecure-dev-caller-pin Cargo feature. No execution
// path is compiled into the ordinary debug or any ordinary release binary.
#[cfg(all(oreslang_debug_cargo_profile, debug_assertions, feature = "insecure-dev-caller-pin"))]
fn main()->Result<(),Box<dyn std::error::Error>>{
 let all_args=env::args().skip(1).collect::<Vec<_>>();
 // This is a debug-only regression path, NEVER a tenant security-service API.
 let tenant_smoke=all_args.first().map(String::as_str)==Some("--tenant-isolation-smoke");
 let growth_smoke=all_args.first().map(String::as_str)==Some("--tenant-memory-growth-smoke");
 let fuel_smoke=all_args.first().map(String::as_str)==Some("--tenant-fuel-starvation-smoke");
 let args=if tenant_smoke || growth_smoke || fuel_smoke {&all_args[1..]} else {&all_args[..]};
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
 if fuel_smoke {
  // The third invocation is an intentionally nonterminating guest loop.
  // Fuel must interrupt that guest, retire only its Store, and invalidate
  // every handle for its old incarnation. This is a bounded-fuel check,
  // NOT asynchronous host cancellation or a process-security proof.
  let mut registry=tenant_isolation::TenantRegistry::new(engine,module,2)?;
  let offender=registry.admit("spin-offender")?;
  let healthy=registry.admit("spin-healthy")?;
  if registry.invoke(&offender,fuel)?!=1 ||
     registry.invoke(&offender,fuel)?!=2 ||
     registry.invoke(&healthy,fuel)?!=1 {
   return Err("fuel starvation fixture did not initialize independently".into());
  }
  let failure=registry.invoke(&offender,fuel);
  let mut cause=match &failure {
   Ok(_) => return Err("nonterminating Wasm tenant completed without exhausting fuel".into()),
   Err(error) => Some(error.as_ref() as &(dyn std::error::Error + 'static)),
  };
  let mut out_of_fuel=false;
  while let Some(error)=cause {
   let message=error.to_string().to_ascii_lowercase();
   if message.contains("all fuel consumed") || message.contains("out of fuel") {
    out_of_fuel=true;
    break;
   }
   cause=error.source();
  }
  if !out_of_fuel {
   return Err("tenant loop failed without a Wasmtime out-of-fuel cause".into());
  }
  if registry.active_tenants()!=1 ||
     registry.invoke(&offender,fuel).is_ok() ||
     registry.begin_shutdown(&offender).is_ok() ||
     registry.destroy(&offender).is_ok() {
   return Err("fuel-exhausted tenant kept its compartment or authority".into());
  }
  if registry.invoke(&healthy,fuel)?!=2 {
   return Err("healthy tenant lost state after neighbor fuel exhaustion".into());
  }
  let fresh=registry.admit("spin-offender")?;
  if registry.invoke(&fresh,fuel)?!=1 ||
     registry.invoke(&healthy,fuel)?!=3 ||
     registry.invoke(&offender,fuel).is_ok() {
   return Err("tenant reincarnation reused stale handle or memory".into());
  }
  registry.begin_shutdown(&fresh)?;
  registry.destroy(&fresh)?;
  registry.begin_shutdown(&healthy)?;
  registry.destroy(&healthy)?;
  if registry.active_tenants()!=0 {
   return Err("fuel starvation smoke leaked tenant Stores".into());
  }
  println!("wasmtime_tenant_fuel_starvation=ok");
  return Ok(());
 }
 if growth_smoke {
  // The guest declares memory 1..2 pages: memory.grow(1) is allowed
  // by the Wasm module. The STRICTER debug-only host Store limit of 1
  // page must deny it on the fourth call. A failure solely due to the
  // module maximum is not accepted as proof of host-limiter enforcement.
  // After this Store-originated trap, retire ONLY the offender.
  let mut registry=tenant_isolation::TenantRegistry::new_for_growth_smoke(engine,module,2)?;
  let healthy=registry.admit("healthy")?;
  let offender=registry.admit("offender")?;
  if registry.invoke(&healthy,fuel)?!=1 ||
     registry.invoke(&offender,fuel)?!=1 ||
     registry.invoke(&offender,fuel)?!=2 ||
     registry.invoke(&offender,fuel)?!=3 {
   return Err("memory growth fixture failed before its expected trap".into());
  }
  // Require the Wasmtime resource limiter's actual growth-denial cause;
  // a fuel exhaustion or unrelated trap must not falsely satisfy this test.
  let growth_error=registry.invoke(&offender,fuel);
  let mut source=match &growth_error {
   Ok(_) => return Err("denied guest memory.grow returned instead of trapping".into()),
   Err(error) => Some(error.as_ref() as &(dyn std::error::Error + 'static)),
  };
  let mut denied_growth=false;
  while let Some(cause)=source {
   let message=cause.to_string();
   if message.contains("forcing trap when growing memory") ||
      message.contains("forcing a memory growth failure to be a trap") {
    denied_growth=true;
    break;
   }
   source=cause.source();
  }
  if !denied_growth {
   return Err("guest failed without a Wasmtime memory-growth limiter cause".into());
  }
  if registry.active_tenants()!=1 ||
     registry.invoke(&offender,fuel).is_ok() ||
     registry.begin_shutdown(&offender).is_ok() ||
     registry.destroy(&offender).is_ok() {
   return Err("memory-growth-trapped tenant retained authority".into());
  }
  if registry.invoke(&healthy,fuel)?!=2 {
   return Err("healthy tenant lost state after neighbor growth trap".into());
  }
  let reincarnated=registry.admit("offender")?;
  if registry.invoke(&reincarnated,fuel)?!=1 ||
     registry.invoke(&healthy,fuel)?!=3 ||
     registry.invoke(&offender,fuel).is_ok() {
   return Err("growth-trapped tenant reincarnation leaked state or authority".into());
  }
  registry.begin_shutdown(&reincarnated)?;
  registry.destroy(&reincarnated)?;
  registry.begin_shutdown(&healthy)?;
  registry.destroy(&healthy)?;
  if registry.active_tenants()!=0 {
   return Err("memory-growth smoke leaked guest compartments".into());
  }
  println!("wasmtime_tenant_memory_growth_trap=ok");
  return Ok(());
 }
 if tenant_smoke {
  // Compile the same AOT code once, but admit each tenant to a distinct
  // Store + Instance. A counter module must retain independent guest state.
  // Two independently constructed OresVM roots can admit the same tenant
  // label and generation. Neither may treat the other's opaque handle as
  // authority, even though both roots share an approved compiled Module.
  let mut other_root=tenant_isolation::TenantRegistry::new(engine.clone(),module.clone(),1)?;
  let foreign_a=other_root.admit("tenant-a")?;
  let mut registry=tenant_isolation::TenantRegistry::new(engine,module,2)?;
  let a=registry.admit("tenant-a")?;
  let b=registry.admit("tenant-b")?;
  if registry.admit("tenant-c").is_ok() ||
     registry.admit("tenant-a").is_ok() ||
     registry.admit("../escaped").is_ok() ||
     registry.admit(".").is_ok() || registry.admit("..").is_ok() ||
     registry.invoke(&foreign_a,fuel).is_ok() ||
     other_root.invoke(&a,fuel).is_ok() ||
     registry.begin_shutdown(&foreign_a).is_ok() ||
     registry.invoke(&a,0).is_ok() {
   return Err("tenant admission, foreign authority, or invalid fuel was accepted".into());
  }
  other_root.begin_shutdown(&foreign_a)?;
  other_root.destroy(&foreign_a)?;
  if other_root.active_tenants()!=0 {
   return Err("foreign root did not retire its own tenant".into());
  }
  let observed=[
   registry.invoke(&a,fuel)?, registry.invoke(&b,fuel)?,
   registry.invoke(&a,fuel)?, registry.invoke(&b,fuel)?
  ];
  if observed != [1,1,2,2]{
   return Err(format!("tenant stores shared state: {observed:?}").into());
  }
  registry.begin_shutdown(&a)?;
  if registry.invoke(&a,fuel).is_ok(){
   return Err("quiescing tenant accepted execution".into());
  }
  registry.destroy(&a)?;
  let fresh_a=registry.admit("tenant-a")?;
  if registry.invoke(&a,fuel).is_ok() || registry.invoke(&fresh_a,fuel)?!=1{
   return Err("stale handle or fresh tenant state failure".into());
  }
  // Keep A alive during B's trap: a failed tenant may not poison a
  // distinct Store or revoke another tenant's live execution authority.
  // A currently holds state 1 and B holds state 2.
  if registry.invoke(&b,1).is_ok(){
   return Err("one-fuel guest unexpectedly completed".into());
  }
  if registry.invoke(&b,fuel).is_ok() ||
     registry.begin_shutdown(&b).is_ok() ||
     registry.destroy(&b).is_ok(){
   return Err("trapped tenant handle retained authority".into());
  }
  if registry.active_tenants()!=1 || registry.invoke(&fresh_a,fuel)?!=2{
   return Err("tenant B trap corrupted healthy tenant A".into());
  }
  let fresh_b=registry.admit("tenant-b")?;
  if registry.invoke(&fresh_b,fuel)?!=1 ||
     registry.invoke(&fresh_a,fuel)?!=3 {
   return Err("post-trap reincarnation leaked memory or disrupted healthy tenant".into());
  }
  registry.begin_shutdown(&fresh_b)?;
  registry.destroy(&fresh_b)?;
  registry.begin_shutdown(&fresh_a)?;
  registry.destroy(&fresh_a)?;
  if registry.active_tenants()!=0{
   return Err("tenant store reclamation failure".into());
  }
  println!("wasmtime_tenant_store_isolation=ok");
  return Ok(());
 }
 let limits=StoreLimitsBuilder::new()
  .memory_size(131072).memories(1).tables(0).instances(1)
  .trap_on_grow_failure(true).build();
 let mut store=Store::new(&engine,limits);
 store.limiter(|limits|limits);
 store.set_fuel(fuel)?;
 let instance=Instance::new(&mut store,&module,&[])?;
 let f=instance.get_typed_func::<(),i64>(&mut store,"main")?;
 println!("{}",f.call(&mut store,())?);
 Ok(())
}
