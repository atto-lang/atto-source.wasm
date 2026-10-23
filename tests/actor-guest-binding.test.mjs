import test from "node:test";
import assert from "node:assert/strict";
import {ActorArena, actorArenaPoolStats} from "../src/actor-arena.mjs";
import {createHash} from "node:crypto";
import {issueTrustedActorGuestPermit} from "../src/actor-guest-authority.mjs";

// A real compiled Wasm program: (import "env" "memory" (memory 2 2))
// (func (export "read") (param i32) (result i32)
//   local.get 0 i32.load8_u)
// This is a low-level guest fixture, NOT a compiled .ores actor.
const reader = Uint8Array.from([
  0,97,115,109,1,0,0,0, 1,6,1,0x60,1,0x7f,1,0x7f,
  2,16,1,3,101,110,118,6,109,101,109,111,114,121,2,1,2,2,
  3,2,1,0, 7,8,1,4,114,101,97,100,0,0,
  10,9,1,7,0,0x20,0,0x2d,0,0,0x0b
]);

function trustedAttach(arena, turn, bytes) {
  // In production only trusted CONTROL supplies this one-shot execution grant.
  const digest = createHash("sha256").update(bytes).digest("hex");
  return arena.attachGuest(turn, bytes,
    issueTrustedActorGuestPermit(arena, digest));
}

function makeActor(id, byte) {
  const arena = new ActorArena({actorId: id, incarnation: 1});
  const turn = arena.beginTurn();
  const slot = arena.allocPersistent(turn, 8);
  arena.write(turn, slot, Uint8Array.of(byte, 2, 3, 4, 5, 6, 7, 8));
  const guest = trustedAttach(arena, turn, reader);
  return {arena, turn, slot, guest};
}

test("real Wasm guests have independent actor-owned imported heaps", () => {
  const a = makeActor(810, 17);
  const b = makeActor(811, 38);
  assert.equal(a.arena.invokeGuest(a.turn, a.guest, "read", 0), 17);
  assert.equal(b.arena.invokeGuest(b.turn, b.guest, "read", 0), 38);
  assert.equal(a.arena.invokeGuest(a.turn, a.guest, "read", 1), 2);
  assert.equal(b.arena.invokeGuest(b.turn, b.guest, "read", 1), 2);
  assert.throws(() => a.arena.invokeGuest(a.turn, b.guest, "read", 0),
    /foreign or detached/);
  assert.throws(() => b.arena.invokeGuest(b.turn, a.guest, "read", 0),
    /foreign or detached/);
  assert.throws(() => a.arena.invokeGuest(a.turn, a.guest, "read", 131072),
    WebAssembly.RuntimeError);
  assert.throws(() => a.arena.invokeGuest(a.turn, a.guest, "missing", 0),
    /not exported/);
  assert.throws(() => a.arena.invokeGuest(a.turn, a.guest, "read", {}),
    /scalar numbers/);
  assert.deepEqual(Reflect.ownKeys(a.guest), [],
    "opaque binding contains no exposed Instance or Memory");
  a.arena.endTurn(a.turn);
  b.arena.endTurn(b.turn);
  assert.throws(() => a.arena.retire(), /outstanding actor lifetime pins/);
  assert.throws(() => b.arena.retire(), /outstanding actor lifetime pins/);
  a.arena.requestRetirement();
  assert.throws(() => a.arena.beginTurn(), /retirement requested/);
  a.arena.detachGuest(a.guest); // authorized completion without another turn
  assert.throws(() => a.arena.detachGuest(a.guest), /detached/);
  a.arena.retire();
  assert.throws(() => b.arena.detachGuest(a.guest), /detached/);
  const next = b.arena.beginTurn();
  assert.equal(b.arena.invokeGuest(next, b.guest, "read", 0), 38,
    "unrelated guest remains live across another actor's retirement");
  b.arena.endTurn(next);
  b.arena.detachGuest(b.guest);
  b.arena.retire();
  assert.equal(actorArenaPoolStats().leasedArenas, 0);
});

test("reused heap never revalidates stale guest binding or leaks previous bytes", () => {
  const owner = makeActor(812, 77);
  owner.arena.endTurn(owner.turn);
  owner.arena.requestRetirement();
  assert.throws(() => owner.arena.retire(), /outstanding actor lifetime pins/);
  owner.arena.detachGuest(owner.guest);
  owner.arena.retire();
  const fresh = new ActorArena({actorId: 812, incarnation: 2});
  const turn = fresh.beginTurn();
  const slot = fresh.allocPersistent(turn, 8);
  assert.deepEqual([...fresh.read(turn, slot)], Array(8).fill(0));
  assert.throws(() => fresh.invokeGuest(turn, owner.guest, "read", 0),
    /foreign or detached/);
  const newGuest = trustedAttach(fresh, turn, reader);
  assert.equal(fresh.invokeGuest(turn, newGuest, "read", 0), 0);
  fresh.write(turn, slot, Uint8Array.of(93, 0, 0, 0, 0, 0, 0, 0));
  assert.equal(fresh.invokeGuest(turn, newGuest, "read", 0), 93);
  fresh.endTurn(turn);
  fresh.detachGuest(newGuest);
  fresh.retire();
});

test("guest admission rejects callbacks, memory exports, start or extra memories", () => {
  const a = new ActorArena({actorId: 813, incarnation: 1});
  const turn = a.beginTurn();
  assert.throws(() => trustedAttach(a, turn, Uint8Array.of(0)), /header/);
  assert.throws(() => trustedAttach(a, turn, Uint8Array.from([...reader, 8, 1, 0])),
    /start sections/);
  assert.throws(() => trustedAttach(a, turn, Uint8Array.from([...reader, 5, 1, 0])),
    /defined memory/);
  // The fixture's export at index 0 is a function; change it to a memory.
  // This is a *valid* Wasm binary, but the bridge must deny memory exports.
  const memoryExport = Uint8Array.from(reader);
  const exportPos = memoryExport.indexOf(7, 20);
  assert.ok(exportPos >= 0);
  // export section: 7,8,1,4,'r','e','a','d',kind=0,index=0
  memoryExport[exportPos + 8] = 2;
  assert.throws(() => trustedAttach(a, turn, memoryExport), /export only functions|only functions/);
  const badImport = Uint8Array.from(reader);
  badImport[20] = 97; // change "env" to "ena"
  assert.throws(() => trustedAttach(a, turn, badImport),
    /exactly one env.memory import/);
  if (typeof SharedArrayBuffer === "function") {
    const shared = new Uint8Array(new SharedArrayBuffer(reader.length));
    shared.set(reader);
    assert.throws(() => trustedAttach(a, turn, shared), /SharedArrayBuffer/);
  }
  assert.equal(a.retirementRequested, false);
  a.endTurn(turn);
  a.retire();
});

test("constructor and guest exports cannot be hijacked by mutable intrinsics", () => {
  const instanceClass = WebAssembly.Instance;
  const imports = WebAssembly.Module.imports;
  const exportsGetter =
    Object.getOwnPropertyDescriptor(WebAssembly.Instance.prototype, "exports");
  const arraySome = Object.getOwnPropertyDescriptor(Array.prototype, "some");
  let hijacks = 0;
  try {
    WebAssembly.Instance = function Spy() { ++hijacks; throw Error("hijacked ctor"); };
    WebAssembly.Module.imports = function SpyImports() {
      ++hijacks;
      throw Error("hijacked imports");
    };
    Object.defineProperty(instanceClass.prototype, "exports", {
      configurable: true, get() { ++hijacks; throw Error("hijacked exports"); }
    });
    Object.defineProperty(Array.prototype, "some", {
      configurable: true, writable: true,
      value() { ++hijacks; throw Error("hijacked Array.some"); }
    });
    const a = makeActor(814, 41);
    assert.equal(a.arena.invokeGuest(a.turn, a.guest, "read", 0), 41);
    a.arena.endTurn(a.turn);
    a.arena.detachGuest(a.guest);
    a.arena.retire();
  } finally {
    WebAssembly.Instance = instanceClass;
    WebAssembly.Module.imports = imports;
    Object.defineProperty(instanceClass.prototype, "exports", exportsGetter);
    Object.defineProperty(Array.prototype, "some", arraySome);
  }
  assert.equal(hijacks, 0);
});

test("untrusted actor heaps exist but direct guest execution requires an isolated worker", () => {
  const a = new ActorArena({actorId: 815, incarnation: 1, kind: "untrusted"});
  const turn = a.beginTurn();
  const slot = a.allocPersistent(turn, 8);
  a.write(turn, slot, Uint8Array.of(55, 2, 3, 4, 5, 6, 7, 8));
  assert.equal(a.read(turn, slot)[0], 55);
  assert.throws(() => a.attachGuest(turn, reader), /untrusted guest requires isolated worker/);
  assert.equal(actorArenaPoolStats().leasedArenas >= 1, true);
  a.endTurn(turn);
  a.retire();
});

test("direct guest trust requires an exact one-shot arena-bound CONTROL permit", () => {
  const a = new ActorArena({actorId: 816, incarnation: 4, kind: "shared"});
  const b = new ActorArena({actorId: 816, incarnation: 4, kind: "shared"});
  const ta = a.beginTurn();
  const tb = b.beginTurn();
  assert.throws(() => a.attachGuest(ta, reader), /forged or consumed/);
  assert.throws(() => a.attachGuest(ta, reader, Object.freeze({})),
    /forged or consumed/);
  const digest = createHash("sha256").update(reader).digest("hex");
  const foreign = issueTrustedActorGuestPermit(b, digest);
  assert.throws(() => a.attachGuest(ta, reader, foreign), /foreign, forged/);
  const wrongDigest = issueTrustedActorGuestPermit(a, "0".repeat(64));
  assert.throws(() => a.attachGuest(ta, reader, wrongDigest),
    /source identity mismatch/);
  const oneUse = issueTrustedActorGuestPermit(a, digest);
  const binding = a.attachGuest(ta, reader, oneUse);
  assert.throws(() => a.attachGuest(ta, reader, oneUse), /consumed/);
  const altered = Uint8Array.from(reader);
  altered[altered.length - 2] = 1;
  const immutablePin = issueTrustedActorGuestPermit(a, digest);
  assert.throws(() => a.attachGuest(ta, altered, immutablePin),
    /source identity mismatch/);
  a.endTurn(ta); b.endTurn(tb);
  a.requestRetirement();
  assert.throws(() => a.retire(), /outstanding actor lifetime pins/);
  a.detachGuest(binding); a.retire(); b.retire();
});
