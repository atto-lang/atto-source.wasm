import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedActorThreadSource} from "../src/actor-max-threads-source-policy.mjs";

const check = text => rejectUnsupportedActorThreadSource(new TextEncoder().encode(text));

test("ETS source table operations reject before compilation",()=>{
 for(const source of [
  "fnc main():int{return ets.new(2);}",
  "fnc main():int{return ets.lookup(1,2);}",
  "fnc main():int{return ets.compare_exchange_versioned(1,2,3);}",
  "fnc main():int{return (ets . insert)(1,2,3);}"
 ]) assert.throws(()=>check(source),/WASM ETS guest table operations unsupported/);
});

test("pg group operations reject before compilation",()=>{
 for(const source of [
  "fnc main():int{return pg.join(1,2);}",
  "fnc main():int{return pg.broadcast(2);}",
  "fnc main():int{return pg . members(2);}",
  "fnc main():int{return pg.leave(2,3);}"
 ]) assert.throws(()=>check(source),/WASM pg guest group operations unsupported/);
});

test("ETS/pg identifiers in strings and nested comments do not trigger gate",()=>{
 for(const source of [
  'fnc main():int{return 42;} // ets.lookup and pg.broadcast',
  'fnc main():int{return 42;} /* pg.join /* ets.insert */ ignored */',
  'fnc main():int{return 42;} // comment\n// pg.broadcast',
  'fnc main():int{return 42;} /* "pg.join" */',
  'fnc main():int{return 42;} // postgres.lookup',
  'fnc main():int{return 42;} // eventpg.members',
  'fnc main():int{return 42;} /* pg.broadcast */'
 ]) assert.doesNotThrow(()=>check(source));
});

test("source preflight denies malformed comments rather than bypassing checks",()=>{
 assert.throws(()=>check("fnc main():int{return 42;} /* pg.broadcast"),/unterminated source comment/);
});

test("preflight never starts guest execution or grants pg/ETS capability",()=>{
 assert.equal(check("fnc main():int{return 42;}"),undefined);
});
