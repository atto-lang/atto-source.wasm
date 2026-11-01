import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedActorThreadSource} from "../src/actor-max-threads-source-policy.mjs";
const bytes = s => new TextEncoder().encode(s);

test("Wasm rejects unsupported nominal state, grain and CONTROL declarations",()=>{
  const prefixes=[
    "state container", "grain", "supervisor", "scheduler",
    "mailman", "proxy actor", "model", "protocol", "service"
  ];
  for (const kind of prefixes) {
    for (const spelling of ["define "+kind, "define pub "+kind]) {
      const src=spelling+" Demo as\nend\n";
      assert.throws(()=>rejectUnsupportedActorThreadSource(bytes(src)),
        /WASM DECL_KIND_UNSUPPORTED/,src);
    }
  }
});
test("Wasm fail-closed words in comments and quoted strings do not grant policy evidence",()=>{
  const source=`fnc main():int {
    // define state container Fake as end
    /* define grain Ghost as end
       /* define supervisor Hidden as end */ */
    const description = "define model Wrong as end";
    const example = 'define protocol Fake as end';
    return 7;
  }`;
  assert.doesNotThrow(()=>rejectUnsupportedActorThreadSource(bytes(source)));
});
test("Wasm ordinary scalar input and contextual identifier names remain accepted by preflight",()=>{
  for (const src of [
    "pub fnc main():int{return 7;}",
    "fnc grain(int model):int{return model;}",
    "fnc state(int container):int{return container;}",
    "fnc supervisor(int grain):int{return grain;}"
  ]) assert.doesNotThrow(()=>rejectUnsupportedActorThreadSource(bytes(src)));
});
test("Wasm cannot confuse comments, malformed UTF8 and state-container declarations",()=>{
  assert.throws(()=>rejectUnsupportedActorThreadSource(bytes("define /* gap */ state container K as end")),
    /WASM DECL_KIND_UNSUPPORTED/);
  assert.throws(()=>rejectUnsupportedActorThreadSource(bytes("define state container X extends Object as end")),
    /WASM DECL_KIND_UNSUPPORTED/);
  assert.throws(()=>rejectUnsupportedActorThreadSource(new Uint8Array([0xff])),/encoded|valid/i);
});
