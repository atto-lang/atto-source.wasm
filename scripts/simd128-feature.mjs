// Experimental SIMD128 policy prerequisite, NOT an Oreslang vector codegen path.
// Even a true engine feature probe does not establish guest compiler capability.
const SIMDruntimeProbe=Uint8Array.from([
  0,97,115,109,1,0,0,0,  // wasm header
  1,4,1,96,0,0,          // () -> ()
  3,2,1,0,               // one function
  10,23,1,21,0,          // body: no locals
  0xfd,0x0c,             // v128.const zero
  ...Array(16).fill(0),  // 16 data bytes
  0x1a,0x0b              // drop, end
]);
export const isSimd128EngineSupported=()=>typeof WebAssembly!=="undefined" &&
 typeof WebAssembly.validate==="function" && WebAssembly.validate(SIMDruntimeProbe);

/**
 * Reject unsupported SIMD requests BEFORE compilation; do not silently
 * fall back to scalar. This policy is a staging primitive only: production
 * code must also audit actual emitted Wasm SIMD opcodes, IR provenance,
 * memory/import/ABI restrictions and exact source functionality.
 */
export function admitSimd128(options={}) {
  // Capability admission is trusted data, not an object protocol. Inherited
  // flags, getters and unknown properties must never grant SIMD authority.
  if(options===null||typeof options!=="object"||Array.isArray(options))
    throw new TypeError("SIMD options must be a plain data object");
  const allowed=new Set(["mode","environment","profileAllowsSimd128",
    "compilerHasVectorLowering","engineSupportsSimd128"]);
  // Snapshot descriptors once. Do not re-read caller properties after
  // verifying they are data properties: proxies or mutation can race reads.
  const snapshot=Object.create(null);
  let prototype;
  try { prototype=Object.getPrototypeOf(options); }
  catch { throw new TypeError("SIMD options must be a plain data object"); }
  if(prototype!==Object.prototype&&prototype!==null)
    throw new TypeError("SIMD options must be a plain data object");
  try {
    for(const key of Reflect.ownKeys(options)){
      const descriptor=Object.getOwnPropertyDescriptor(options,key);
      if(typeof key!=="string"||!allowed.has(key)||!descriptor||
        !Object.hasOwn(descriptor,"value"))
        throw new TypeError("SIMD options must contain only known own data fields");
      snapshot[key]=descriptor.value;
    }
  }catch{
    throw new TypeError("SIMD options must contain only known own data fields");
  }
  const {mode="scalar",environment,profileAllowsSimd128=false,
    compilerHasVectorLowering=false,engineSupportsSimd128}=snapshot;
  // A scalar build must work even if the runtime has no WebAssembly API.
  if(engineSupportsSimd128===undefined)
    engineSupportsSimd128=mode==="simd128" && isSimd128EngineSupported();
  if(!["scalar","simd128"].includes(mode))throw new Error("unknown SIMD mode");
  if(!["browser","edge-js","edge-wasi"].includes(environment))
    throw new Error("unsupported Wasm environment");
  if([profileAllowsSimd128,compilerHasVectorLowering,engineSupportsSimd128]
    .some(value=>typeof value!=="boolean"))
    throw new TypeError("SIMD capabilities must be boolean");
  if(mode==="scalar")return Object.freeze({mode:"scalar",status:"PRE_FLIGHT_ONLY"});
  if(!profileAllowsSimd128)throw new Error("target profile forbids SIMD128");
  if(!compilerHasVectorLowering)throw new Error("real compiler SIMD128 lowering not established");
  if(!engineSupportsSimd128)throw new Error("target engine rejects SIMD128");
  return Object.freeze({mode:"simd128",status:"PRE_FLIGHT_ONLY"});
}
