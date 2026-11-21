import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {openStore} from "./mixed-layout-test-adapter.mjs";

// The same source file runs against private JS ArrayBuffer storage and real
// WebAssembly.Memory actor arenas. This is host-runtime, not guest-code proof.
const contract=JSON.parse(readFileSync(
  new URL("../contracts/v1/mixed-layout-golden-v1.json",import.meta.url),"utf8"));
assert.equal(contract.version,1);
const widths={u32:4,f64:8,bool:1,ref32:4};
let actorId=31000;

for(const vector of contract.layouts){
  test(`portable mixed-layout v1: ${vector.layout} cell isolation and atomic rejection`,()=>{
    const store=openStore({...vector,fields:contract.fields},actorId++);
    try{
      const occupied=new Map();
      for(let row=0;row<vector.rows;row++){
        for(const field of contract.fields){
          const width=widths[field.type],offset=store.offset(row,field.name);
          assert.ok(Number.isInteger(offset) && offset>=0 &&
            offset+width<=store.byteLength,`${row}/${field.name} in allocation`);
          assert.equal(offset%width,0,`${row}/${field.name} alignment`);
          for(let byte=offset;byte<offset+width;byte++){
            assert.equal(occupied.has(byte),false,
              `${row}/${field.name} overlaps ${occupied.get(byte)} at ${byte}`);
            occupied.set(byte,`${row}/${field.name}`);
          }
        }
        assert.equal(store.read(row,"id"),0);
        assert.equal(store.read(row,"next"),0);
        assert.equal(store.read(row,"flag"),false);
        assert.ok(Object.is(store.read(row,"x"),0),"f64 cell starts +0");
      }
      // Populate EVERY logical cell with a row-dependent pattern. This catches
      // aliasing and writes into neighboring rows, columns, or masked lanes.
      for(let row=0;row<vector.rows;row++){
        store.write(row,"id",0xffffffff-row);
        store.write(row,"next",0x80000000+row);
        store.write(row,"flag",row%2===0);
        store.write(row,"x",row+0.375);
      }
      const verify=()=>{
        for(let row=0;row<vector.rows;row++){
          assert.equal(store.read(row,"id"),0xffffffff-row);
          assert.equal(store.read(row,"next"),0x80000000+row);
          assert.equal(store.read(row,"flag"),row%2===0);
          assert.equal(store.read(row,"x"),row+0.375);
        }
      };
      verify();
      for(const [field,value] of [
        ["id",-1],["id",0x100000000],["id",1.5],["id","4"],
        ["next",-1],["next",Number.NaN],["flag",1],["flag","true"],
        ["x","4"],["x",null]
      ]){
        assert.throws(()=>store.write(0,field,value),
          `invalid ${field} value ${String(value)}`);
      }
      assert.throws(()=>store.write(-1,"id",1));
      assert.throws(()=>store.write(vector.rows,"flag",false));
      assert.throws(()=>store.read(vector.rows,"x"));
      assert.throws(()=>store.write(0,"unknown",1));
      verify(); // All rejected operations preserve every logical cell.
    }finally{store.close();}
    assert.throws(()=>store.read(0,"id"),"stale reads remain rejected");
    assert.throws(()=>store.write(0,"flag",false),"stale writes remain rejected");
  });
}
