import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedActorThreadSource} from "../src/actor-max-threads-source-policy.mjs";

const bytes = source => new TextEncoder().encode(source);

test("Wasm source bridge rejects every actor declaration prefix", () => {
  for (const source of [
    "define actor A1 as end",
    "actor A1 as end",
    "actor worker as end",
    "actor A1 extends Base as end",
    "actor A1 implements Interface as end",
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
