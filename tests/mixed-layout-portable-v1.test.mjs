import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {openStore} from "./mixed-layout-test-adapter.mjs";

const contract=JSON.parse(readFileSync(new URL("../contracts/v1/mixed-layout-golden-v1.json",import.meta.url),"utf8"));
assert.equal(contract.version,1);
assert.equal(contract.scope,"runtime-host-mixed-layout-only");
let actor=20000;
for(const vector of contract.layouts){
  test(`portable mixed-layout v1: ${vector.layout} values, bytes and lifetime`,()=>{
    const store=openStore({...vector,fields:contract.fields},actor++);
    try{
      assert.equal(store.byteLength,vector.byteLength);
      assert.equal(store.payloadBytes,vector.payloadBytes);
      for(const [row,field,offset] of vector.offsets)
        assert.equal(store.offset(row,field),offset,`${row}/${field}`);
      for(let row=0;row<vector.rows;row++){
        assert.equal(store.read(row,"id"),0);
        assert.equal(store.read(row,"flag"),false);
      }
      store.write(0,"id",0xffffffff);
      store.write(0,"next",0xffffffff);
      store.write(0,"flag",true);
      store.write(0,"x",-0);
      store.write(1,"x",NaN);
      store.write(2,"x",Infinity);
      assert.equal(store.read(0,"id"),0xffffffff);
      assert.equal(store.read(0,"next"),0xffffffff);
      assert.equal(store.read(0,"flag"),true);
      assert.ok(Object.is(store.read(0,"x"),-0));
      assert.ok(Number.isNaN(store.read(1,"x")));
      assert.equal(store.read(2,"x"),Infinity);
      store.write(2,"x",-Infinity);
      assert.equal(store.read(2,"x"),-Infinity);
      assert.throws(()=>store.write(vector.rows,"id",42));
      assert.throws(()=>store.read(-1,"id"));
      assert.throws(()=>store.write(0,"not_declared",42));
      assert.equal(store.read(0,"id"),0xffffffff,"failed writes preserve prior state");
    }finally{store.close();}
    assert.throws(()=>store.read(0,"id"));
    assert.throws(()=>store.write(0,"id",1));
    store.close();
  });
  test(`portable mixed-layout v1: ${vector.layout} rejects nonpositive rows`,()=>{
    for(const rows of contract.rejectRows)
      assert.throws(()=>openStore({...vector,fields:contract.fields,rows},actor++));
  });
}
