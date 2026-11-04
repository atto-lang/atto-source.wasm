import test from "node:test";
import assert from "node:assert/strict";
import {compileAdmittedCoreGuest} from "../src/guest-admission.mjs";

// Intentionally malformed bytes: unsupported capability requests must fail
// BEFORE Wasm compilation. A test fixture must not accidentally instantiate
// a source actor, import callbacks or start a reactor in core-wasm.i64-v1.
const INVALID_GUEST = Uint8Array.of(0);

test("native test actors cannot be materialized by requesting physical turns",()=>{
  for (const requested of [1,2,-1,true,"1"]) {
    assert.throws(
      () => compileAdmittedCoreGuest(INVALID_GUEST,{actorPhysicalTurns:requested}),
      /physical source actor execution is unsupported/
    );
  }
});

test("native async I/O and reactors stay unavailable to test callbacks/tasks",()=>{
  for(const ioMode of ["blocking","sync","testkit"]) {
    assert.throws(()=>compileAdmittedCoreGuest(INVALID_GUEST,{ioMode}),
      /refuses legacy\/blocking host I\/O/);
  }
  for(const guestNetworkIo of [true,1,"enabled"]) {
    assert.throws(()=>compileAdmittedCoreGuest(INVALID_GUEST,{guestNetworkIo}),
      /guest NIO is not implemented/);
  }
  for(const nioReactors of [1,2,true]) {
    assert.throws(()=>compileAdmittedCoreGuest(INVALID_GUEST,{nioReactors}),
      /reactor threads are unsupported/);
  }
});

test("hard real-time claims cannot bypass absent actor scheduler",()=>{
  for(const hardRealtime of [true,1,"yes"]) {
    assert.throws(()=>compileAdmittedCoreGuest(INVALID_GUEST,{hardRealtime}),
      /hard-real-time scheduling is unsupported/);
  }
});

test("zero capability admission must still reject invalid guest bytes",()=>{
  assert.throws(
    () => compileAdmittedCoreGuest(INVALID_GUEST,{
      actorPhysicalTurns:0,guestNetworkIo:false,nioReactors:0,ioMode:"nio-only",hardRealtime:false
    }),
    /Wasm|magic|short|truncated|header|module|bytes|invalid/i
  );
});
