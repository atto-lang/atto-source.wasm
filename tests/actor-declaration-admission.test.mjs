import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {rejectUnsupportedActorThreadSource} from "../src/actor-max-threads-source-policy.mjs";

const bytes = source => new TextEncoder().encode(source);

test("Wasm source bridge rejects every actor declaration prefix", () => {
  for (const source of [
    "define actor A1 as end",
    "actor A1 as end",
    "actor worker as end",
    "actor A1 extends Base as end",
    "actor A1 implements Interface as end",
    "actor A1 with Mixin as end",
    "define suspends actor A1 as end",
    "actor suspends fnc work():int{return 1;}",
    "actor fnc work():int{return 1;}",
    "fnc actor work():int{return 1;}",
    "actor routine work():int{return 1;}",
    "define pub actor A1 as end",
    "define shared actor A1 as end",
    "define untrusted actor A1 as end",
    "define isoactor A1 as end",
    "define pub isoactor A1 as end",
    "shared actor A1 { }",
    "untrusted actor A1 { }",
    "isoactor A1 { }",
    "define http actor A1 as end",
    "define serial http actor A1 as end",
    "define abstract actor A1 as end",
    "define transform actor A1 as end",
    "define pipe actor A1 as end",
    "define tcp actor A1 as end",
    "define websocket actor A1 as end",
    "define unary actor A1 as end",
    "define actor A1 extends Parent as end",
    "define actor A1 implements Observer as end",
    "define pub actor A1 impl Tagged as end",
    "define actor A1 as\n receive(ActorMail<int> mail):void {return;}\nend"
  ]) {
    assert.throws(() => rejectUnsupportedActorThreadSource(bytes(source)),
      /WASM source actor execution unsupported: no guest actor scheduler/,
      source);
  }
});

test("Wasm admission never treats comments or strings as actor declarations", () => {
  for (const source of [
    "// define pub actor A1 as end\nfnc main():int{return 1;}",
    "/* define isoactor A1 as /* shared actor Bad {} */ end */ fnc main():int{return 1;}",
    "fnc main():int{const msg=\"define untrusted actor Evil as end\";return 1;}",
    "define module helpers as fnc actor_value():int{return 3;} end",
    "fnc actor_count():int{return 3;}",
    "fnc main():int{let actor=1;return actor;}"
  ]) {
    assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes(source)),source);
  }
});

test("Wasm source bridge fails closed on supervisor tree declarations", () => {
  for (const source of [
    "define supervisor Root as end",
    "define pub supervisor Root as end",
    "define private supervisor Internal as end",
    "define abstract supervisor Root as end",
    "define serial supervisor Root as end",
    "define supervisor Root extends Parent as end",
    "define supervisor Root implements SupervisorPolicy as end",
    "supervisor Root as end",
    "supervisor Root extends Parent as end"
  ]) {
    assert.throws(() => rejectUnsupportedActorThreadSource(bytes(source)),
      /WASM source supervisor unsupported: no typed Failure or CONTROL lowering/,
      source);
  }
});

test("supervisor references in nondeclaration source remain legal tokens", () => {
  for (const source of [
    "// define pub supervisor Root as end\nfnc main():int{return 1;}",
    "/* define supervisor Root as end */ fnc main():int{return 1;}",
    "fnc main():int{const x=\"define supervisor Fake as end\";return 1;}",
    "fnc main():int{let supervisor=1;return supervisor;}",
    "fnc main():int{let x=supervisor.status;return 1;}",
    "define module supervisor_helpers as fnc count():int{return 1;} end"
  ]) {
    assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes(source)),
      source);
  }
});

test("malformed UTF-8 and unterminated comments fail before compilation", () => {
  assert.throws(
    () => rejectUnsupportedActorThreadSource(Uint8Array.of(0xc0,0xaf)),
    /encoded data was not valid/i
  );
  assert.throws(
    () => rejectUnsupportedActorThreadSource(bytes("/* define actor A1 as")),
    /unterminated source comment/
  );
});

test("standalone policy refuses oversized source before UTF-8 decoding", () => {
  const overLimit = new Uint8Array(1024 * 1024 + 1).fill(0x20);
  assert.throws(
    () => rejectUnsupportedActorThreadSource(overLimit),
    /WASM source preflight exceeds 1 MiB byte budget/
  );
  // The compiler bridge and standalone actor policy use the same byte bound.
  assert.doesNotThrow(
    () => rejectUnsupportedActorThreadSource(new Uint8Array(1024 * 1024).fill(0x20))
  );
});

test("comment nesting and executable token-count budgets are enforced", () => {
  assert.throws(
    () => rejectUnsupportedActorThreadSource(bytes("/*".repeat(129) + "*/".repeat(129))),
    /source comment nesting exceeded/
  );
  assert.throws(
    () => rejectUnsupportedActorThreadSource(bytes("a ".repeat(100_001))),
    /source token budget exceeded/
  );
  assert.throws(
    () => rejectUnsupportedActorThreadSource(bytes('"unterminated')),
    /unterminated source string/
  );
});

test("exact conformance lifecycle source fails closed before Wasm scalar compilation", () => {
  const guest = readFileSync(new URL("./fixtures/actor-execution-v1.ores", import.meta.url));
  const sha = createHash("sha1")
    .update("blob " + guest.length + "\0").update(guest).digest("hex");
  assert.equal(sha, "7b358d4871f931f21d1a874a15802ac3dd32ba64");
  assert.throws(
    () => rejectUnsupportedActorThreadSource(guest),
    /WASM source actor execution unsupported: no guest actor scheduler/
  );
});

test("CR-only, NEL and Unicode comment lines cannot hide unsupported actors", () => {
  for (const separator of ["\r", "\u0085", "\u2028", "\u2029"]) {
    const label = "U+" + separator.charCodeAt(0).toString(16);
    assert.throws(() => rejectUnsupportedActorThreadSource(bytes("// hidden actor" + separator + "define actor Worker as end")),
      /WASM source actor execution unsupported/, label);
    assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(bytes("// actor ignored" + separator + "fnc main():int{return 42;}")), label);
  }
});

test('reserved MaxActorThreads enum is denied behind visibility modifiers',()=>{
  for(const source of [
    'define enum MaxActorThreads as end',
    'define pub enum MaxActorThreads as end',
    'define private enum MaxActorThreads as end',
    'define pub private enum MaxActorThreads as end'
  ])assert.throws(()=>rejectUnsupportedActorThreadSource(bytes(source)),
    /WASM built-in MaxActorThreads enum unsupported/,source);
  assert.doesNotThrow(()=>rejectUnsupportedActorThreadSource(bytes(
    'define pub enum UserColors as red end')));
});

test("NEL U+0085 cannot split reserved enum tokens in scalar Wasm preflight",()=>{
  for(const source of [
    "define\u0085enum\u0085MaxActorThreads as end",
    "define\u0085pub\u0085enum\u0085MaxActorThreads as end",
    "define pub\u0085enum MaxActorThreads as end"
  ])assert.throws(()=>rejectUnsupportedActorThreadSource(bytes(source)),
    /built-in MaxActorThreads enum unsupported/,source);
  assert.doesNotThrow(()=>rejectUnsupportedActorThreadSource(bytes(
    "define\u0085pub\u0085enum\u0085Color as red end")));
});

test("Wasm scalar source preflight cannot be fooled by byteLength or buffer shadowing",()=>{
  const oversized=new Uint8Array(1_048_577);
  Object.defineProperty(oversized,"byteLength",{get(){return 1}});
  assert.throws(()=>rejectUnsupportedActorThreadSource(oversized),/1 MiB byte budget/);
  if(typeof SharedArrayBuffer==="function"){
    const shared=new Uint8Array(new SharedArrayBuffer(64));
    Object.defineProperty(shared,"buffer",{value:new ArrayBuffer(64)});
    assert.throws(()=>rejectUnsupportedActorThreadSource(shared),/refuses shared source backing/);
  }
  assert.doesNotThrow(()=>rejectUnsupportedActorThreadSource(bytes("fnc main():int{return 42;}")));
});

test("NEL-separated actor modifiers and reserved enums retain fail-closed lexical admission",()=>{
  for(const source of [
    'define\u0085private\u0085enum\u0085MaxActorThreads as end',
    'define\u0085pub\u0085private\u0085enum\u0085MaxActorThreads as end'
  ])assert.throws(()=>rejectUnsupportedActorThreadSource(bytes(source)),
    /built-in MaxActorThreads enum unsupported/,source);
  for(const source of [
    'define\u0085http\u0085actor\u0085Server as end',
    'define\u0085serial\u0085http\u0085actor\u0085Server as end'
  ])assert.throws(()=>rejectUnsupportedActorThreadSource(bytes(source)),
    /WASM source actor execution unsupported/,source);
});

test('reserved MaxActorThreads enum cannot hide behind stacked modifiers',()=>{
  for(const modifiers of ['shared','pub shared','private untrusted','abstract','serial']){
    const source='define '+modifiers+' enum MaxActorThreads as end';
    assert.throws(()=>rejectUnsupportedActorThreadSource(bytes(source)),
      /built-in MaxActorThreads enum unsupported/,source);
  }
  assert.doesNotThrow(()=>rejectUnsupportedActorThreadSource(bytes(
    'define pub shared enum UserColors as red end')));
});

test("shared-backed actor preflight is denied before lexing mutable bytes", () => {
  if (typeof SharedArrayBuffer === "undefined") return;
  const safe = bytes("fnc main():int{return 42;}");
  const shared = new Uint8Array(new SharedArrayBuffer(safe.length));
  shared.set(safe);
  assert.throws(
    () => rejectUnsupportedActorThreadSource(shared),
    /WASM source preflight refuses shared source backing/
  );
  // A private copy remains valid and does not grant actor capabilities.
  assert.doesNotThrow(() => rejectUnsupportedActorThreadSource(new Uint8Array(shared)));
});

test("line comment terminators cannot conceal later actor declarations", () => {
  for (const newline of ["\n", "\r", "\r\n", "\u0085", "\u2028", "\u2029"]) {
    assert.throws(
      () => rejectUnsupportedActorThreadSource(bytes(
        "// harmless actor Fake as end" + newline + "actor Real as end"
      )),
      /WASM source actor execution unsupported/,
      "comment terminator " + JSON.stringify(newline)
    );
    assert.doesNotThrow(
      () => rejectUnsupportedActorThreadSource(bytes(
        "// fake actor A1 as end" + newline + "fnc main():int{return 42;}"
      ))
    );
  }
});

test("oversized declaration modifier chains reject rather than bypass actor policy", () => {
  const chain = "pub ".repeat(33);
  for (const target of ["actor A1 as end", "supervisor Root as end"]) {
    assert.throws(
      () => rejectUnsupportedActorThreadSource(bytes("define " + chain + target)),
      /source declaration modifier budget exceeded/
    );
  }
  assert.throws(
    () => rejectUnsupportedActorThreadSource(bytes("define " + "pub ".repeat(32) + "actor A1 as end")),
    /WASM source actor execution unsupported/
  );
});

test("SAB spoofed .buffer getter cannot evade source preflight", () => {
  if (typeof SharedArrayBuffer === "undefined") return;
  const source = bytes("fnc main():int{return 42;}");
  const unsafe = new Uint8Array(new SharedArrayBuffer(source.length));
  unsafe.set(source);
  Object.defineProperty(unsafe, "buffer", {
    get() { return new ArrayBuffer(source.length); }
  });
  assert.throws(
    () => rejectUnsupportedActorThreadSource(unsafe),
    /WASM source preflight refuses shared source backing/
  );
});

test("Proxy source views are refused without executing traps", () => {
  let traps = 0;
  const input = new Proxy(bytes("actor Real as end"), {
    get() { traps++; throw new Error("unexpected byte trap"); }
  });
  assert.throws(
    () => rejectUnsupportedActorThreadSource(input),
    /preflight rejects Proxy byte views/
  );
  assert.equal(traps, 0);
});

test("spoofed typed-array byteLength cannot bypass source size budget", () => {
  const source = new Uint8Array(1_048_577).fill(0x20);
  Object.defineProperty(source, "byteLength", {get() { return 0; }});
  assert.throws(
    () => rejectUnsupportedActorThreadSource(source),
    /WASM source preflight exceeds 1 MiB byte budget/
  );
});
