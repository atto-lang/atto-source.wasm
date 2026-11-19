// Fail-closed browser Wasm v1 profile. Rust-produced guest memories are fixed
// at 1 or 16 pages; arbitrary unbounded memory/table declarations are denied.
export const MAX_WASM_BYTES = 1 << 20;
export const MAX_WASM_PAGES = 16;
export const MAX_ACTOR_TYPES = 64;

function uleb(bytes, state, end) {
  let n = 0, shift = 0;
  for (let i=0; i<5; i++) {
    if (state.i>=end) throw new Error('E_WASM_LAYOUT');
    const byte=bytes[state.i++];
    n += (byte & 127) * (2 ** shift);
    if (n > 0xffffffff) throw new Error('E_WASM_LAYOUT');
    if (!(byte & 128)) return n;
    shift+=7;
  }
  throw new Error('E_WASM_LAYOUT');
}

export function fixed_memory_pages(input) {
  const bytes=input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length<8 || bytes[0]!==0 || bytes[1]!==97 || bytes[2]!==115 || bytes[3]!==109 ||
      bytes[4]!==1 || bytes[5]!==0 || bytes[6]!==0 || bytes[7]!==0) throw new Error('E_WASM_HEADER');
  const state={i:8};
  let seen_memory=false, seen_table=false, pages=0;
  while (state.i < bytes.length) {
    const id=bytes[state.i++];
    const size=uleb(bytes,state,bytes.length);
    const end=state.i+size;
    if (end>bytes.length) throw new Error('E_WASM_LAYOUT');
    // The Rust compiler emits no Wasm start function. A hostile guest with a
    // start section could run before the host has finished constructing its
    // instance-scoped bindings and actor ownership bookkeeping.
    if (id===8) throw new Error('E_WASM_START');
    if (id===4) {
      if (seen_table) throw new Error('E_WASM_TABLE');
      seen_table=true;
      if (uleb(bytes,state,end)!==0) throw new Error('E_WASM_TABLE');
      if (state.i!==end) throw new Error('E_WASM_LAYOUT');
    }
    if (id===5) {
      if (seen_memory) throw new Error('E_WASM_MEMORY');
      seen_memory=true;
      const count=uleb(bytes,state,end);
      if (count>1) throw new Error('E_WASM_MEMORY');
      if (count===1) {
        // v1 forbids shared, memory64, growth and >16 fixed 64 KiB pages.
        if (uleb(bytes,state,end)!==1) throw new Error('E_WASM_MEMORY');
        const min=uleb(bytes,state,end),max=uleb(bytes,state,end);
        if (!min || min!==max || max>MAX_WASM_PAGES) throw new Error('E_WASM_MEMORY');
        pages=max;
      }
      if (state.i!==end) throw new Error('E_WASM_LAYOUT');
    }
    state.i=end;
  }
  return pages;
}

export function actor_names(module) {
  const sections=WebAssembly.Module.customSections(module,'atto.actors');
  if (sections.length>1) throw new Error('E_WASM_ACTORS');
  if (!sections.length) return [];
  const bytes=new Uint8Array(sections[0]),state={i:0};
  const count=uleb(bytes,state,bytes.length);
  if (count<1 || count>MAX_ACTOR_TYPES) throw new Error('E_WASM_ACTORS');
  const names=[],seen=new Set();
  const decoder=new TextDecoder('utf-8',{fatal:true});
  for (let k=0;k<count;k++) {
    const len=uleb(bytes,state,bytes.length);
    if (!len || len>256 || state.i+len>bytes.length) throw new Error('E_WASM_ACTORS');
    let name;
    try {name=decoder.decode(bytes.subarray(state.i,state.i+len));}catch{throw new Error('E_WASM_ACTORS');}
    if(seen.has(name)) throw new Error('E_WASM_ACTORS');
    seen.add(name);names.push(name);state.i+=len;
  }
  if (state.i!==bytes.length) throw new Error('E_WASM_ACTORS');
  return names;
}
