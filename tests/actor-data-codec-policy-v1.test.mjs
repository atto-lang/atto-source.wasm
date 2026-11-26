import test from "node:test";
import assert from "node:assert/strict";
import {bindActorDataCodec as bind} from "../src/actor-data-codec-policy-v1.mjs";
const h="07".repeat(32), h2="08".repeat(32);
test("default and explicit policy",()=>{
  bind(null,15,1,2,"order.v1",h)("messagepack",2,"order.v1",h);
  for(const [label,m] of [["protobuf",2],["cbor",4],["flatbuffers",8]])
    bind(label,15,m,1,"s",h)(label,1,"s",h);
});
test("reject fallback and malformed registration",()=>{
  for(const [args,error] of [
    [[null,2,2,1,"s",h],"Denied"],
    [["protobuf",15,1,1,"s",h],"Unsupported"],
    [["CBOR",15,15,1,"s",h],"UnknownCodec"],
    [["",15,15,1,"s",h],"UnknownCodec"],
    [[undefined,15,15,1,"s",h],"UnknownCodec"],
    [[null,16,1,1,"s",h],"InvalidMask"],
    [[null,-1,1,1,"s",h],"InvalidMask"],
    [[null,1,1,0,"s",h],"InvalidBinding"],
    [[null,1,1,0x100000000,"s",h],"InvalidBinding"],
    [[null,1,1,2,"s",h.slice(1)],"InvalidBinding"],
    [[null,1,1,2,"s","GG".repeat(32)],"InvalidBinding"],
    [[null,1,1,2,"s",h+"\n"],"InvalidBinding"]
  ]) assert.throws(()=>bind(...args),{message:error});
  for(const s of ["","a b","é","x".repeat(257)])
    assert.throws(()=>bind(null,1,1,2,s,h),{message:"InvalidBinding"});
  bind(null,1,1,2,"x".repeat(256),h);
});
test("reject metadata mismatch and object coercion",()=>{
  const b=bind(null,1,1,2,"order.v1",h);
  for(const args of [["protobuf",2,"order.v1",h],["messagepack",1,"order.v1",h],
    ["messagepack",2,"order.v2",h],["messagepack",2,"order.v1",h2],
    ["MESSAGEPACK",2,"order.v1",h]]) assert.throws(()=>b(...args),{message:"Mismatch"});
  let calls=0;
  const hostile={toString(){calls++;throw Error("coerced");},valueOf(){calls++;throw Error("coerced");}};
  assert.throws(()=>bind(hostile,15,15,1,"s",h),{message:"UnknownCodec"});
  assert.throws(()=>bind(null,hostile,1,1,"s",h),{message:"InvalidMask"});
  assert.throws(()=>b("messagepack",2,"order.v1",hostile),{message:"Mismatch"});
  assert.equal(calls,0);
});
