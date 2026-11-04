import test from "node:test";
import assert from "node:assert/strict";
import {assertPrimaryReceiverSlotRejection} from "./receiver-slot-diagnostic.mjs";

test("receiver duplicate diagnostics must be primary, exact, and no-IR",()=>{
  for(const slot of ["x/0","x/1"]) {
    const file="zero-forward.ores";
    const good={status:1,error:undefined,signal:null,stdout:"",
      stderr:"oreslang-llvmc: duplicate native method name/arity '"+slot+
        "' (self receiver does not count toward arity) at byte 37 [file: "+
        file+"]\n"};
    assert.equal(assertPrimaryReceiverSlotRejection(good,slot,file),true);
    for(const bad of [
      {...good,status:0},
      {...good,status:139},
      {...good,stdout:"; ModuleID = forged"},
      {...good,signal:"SIGSEGV"},
      {...good,error:new Error("spawn failed")},
      {...good,stderr:"oreslang-llvmc: unsupported target\n"+good.stderr},
      {...good,stderr:good.stderr.replace(slot,slot+"0")},
      {...good,stderr:good.stderr.replace("at byte 37","at byte bogus")},
      {...good,stderr:good.stderr.replace("[file: "+file+"]","[file: other.ores]")},
      {...good,stderr:good.stderr.replace(" (self receiver"," trailing other words (self receiver")}
    ])assert.throws(()=>assertPrimaryReceiverSlotRejection(bad,slot,file));
    assert.throws(()=>assertPrimaryReceiverSlotRejection(good,slot,"wrong.ores"));
  }
  assert.throws(()=>assertPrimaryReceiverSlotRejection({}, "x/0","a.ores"));
  assert.throws(()=>assertPrimaryReceiverSlotRejection({status:1,stdout:"",stderr:""},
    "x/55","a.ores"));
});
