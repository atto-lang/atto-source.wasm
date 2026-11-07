import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {HostContinuationTicketFenceV0} from "../src/host-continuation-ticket-fence-v0.mjs";
import {SupervisedPooledActor} from "../src/supervised-pooled-actor.mjs";
import {PooledWasmActors} from "../src/pooled-actor-host.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const wasmPlaceholder = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
const approved = sha256(wasmPlaceholder);

function hostPoolFixture() {
  const pool = new PooledWasmActors({workers: 1, maxActors: 2});
  const issued = [];
  const sourceSpawn = pool.spawn;
  pool.spawn = async (_bytes, {onTerminalControl}) => {
    const id = issued.length + 1;
    let live = true;
    const raw = {
      id,
      async send(value) {
        if (!live) throw Error("raw actor retired");
        return value;
      },
      async stop() {live = false;}
    };
    issued.push({id, raw, onTerminalControl});
    return raw;
  };
  return {
    pool,
    issued,
    restore: () => {pool.spawn = sourceSpawn;},
    control: (reason = "STACK_BUDGET_EXHAUSTED_V1") => {
      const last = issued.at(-1);
      last.onTerminalControl(Object.freeze({
        schemaVersion: 1,
        kind: "ACTOR_TERMINAL_CONTROL",
        reason,
        actorId: last.id,
        terminalTicket: last.id,
        actorRetired: true,
        frameQuiescent: true,
        carrierRetained: true
      }));
    }
  };
}

test("opaque host ticket is one-use accounting, never guest continuation authorization", () => {
  const gate = new HostContinuationTicketFenceV0();
  gate.activate(1);
  const ticket = gate.mint(1);
  assert.equal(Object.getPrototypeOf(ticket), null);
  assert.equal(Object.isFrozen(ticket), true);
  assert.deepEqual(Object.keys(ticket), []);
  assert.equal(gate.pendingCount, 1);
  assert.throws(() => gate.resumeGuest(ticket, 1),
    /ATTO_GUEST_SUSPEND_RESUME_NOT_IMPLEMENTED/);
  assert.equal(gate.pendingCount, 1, "unsupported guest resume may not consume the ticket");
  const claim = gate.claimHostOnly(ticket, 1);
  assert.deepEqual(claim, {
    schemaVersion: 0,
    kind: "HOST_CONTINUATION_ACCOUNTING_ONLY",
    generation: 1,
    guestResumeAuthorized: false
  });
  assert.ok(Object.isFrozen(claim));
  assert.equal(gate.pendingCount, 0);
  assert.throws(() => gate.claimHostOnly(ticket, 1), /STALE_OR_REPLAYED/);
  assert.throws(() => gate.resumeGuest(ticket, 1), /STALE_OR_REPLAYED/);
});

test("retired generation invalidates all outstanding tokens before reactivation", () => {
  const gate = new HostContinuationTicketFenceV0();
  gate.activate(1);
  const first = gate.mint(1), second = gate.mint(1);
  assert.equal(gate.retire(1), 2);
  assert.equal(gate.pendingCount, 0);
  assert.equal(gate.retired, true);
  assert.equal(gate.retire(1), 0, "same-generation retirement is idempotent");
  assert.throws(() => gate.claimHostOnly(first, 1), /STALE_OR_REPLAYED/);
  assert.throws(() => gate.resumeGuest(second, 1), /STALE_OR_REPLAYED/);
  gate.activate(2);
  assert.throws(() => gate.mint(1), /STALE_ACTOR_GENERATION/);
  assert.throws(() => gate.claimHostOnly(first, 2), /STALE_OR_REPLAYED/);
  const current = gate.mint(2);
  assert.equal(gate.claimHostOnly(current, 2).guestResumeAuthorized, false);
});

test("one-use tickets cannot be transferred by cloning, guessed or used by another authority", () => {
  const a = new HostContinuationTicketFenceV0();
  const b = new HostContinuationTicketFenceV0();
  a.activate(1); b.activate(1);
  const ticket = a.mint(1);
  assert.throws(() => b.claimHostOnly(ticket, 1), /INVALID_HOST_CONTINUATION_TICKET/);
  assert.throws(() => a.claimHostOnly(structuredClone(ticket), 1),
    /INVALID_HOST_CONTINUATION_TICKET/);
  assert.throws(() => a.claimHostOnly(Object.freeze({}), 1),
    /INVALID_HOST_CONTINUATION_TICKET/);
  assert.throws(() => a.claimHostOnly("ticket-1", 1),
    /INVALID_HOST_CONTINUATION_TICKET/);
  assert.equal(a.pendingCount, 1, "attacks may not consume authentic ticket");
  assert.equal(a.cancel(ticket, 1), true);
  assert.throws(() => a.cancel(ticket, 1), /STALE_OR_REPLAYED/);
});

test("bounded ticket quota is reclaimed by cancel and retire; invalid generations deny", () => {
  assert.throws(() => new HostContinuationTicketFenceV0({maxPending: 0}), /quota/);
  assert.throws(() => new HostContinuationTicketFenceV0({maxPending: 65}), /quota/);
  assert.throws(() => new HostContinuationTicketFenceV0({maxPending: 1.5}), /quota/);
  const gate = new HostContinuationTicketFenceV0({maxPending: 2});
  assert.throws(() => gate.activate(2), /GENERATION_NOT_ADMITTED/);
  gate.activate(1);
  assert.throws(() => gate.activate(2), /GENERATION_NOT_ADMITTED/);
  const a = gate.mint(1), b = gate.mint(1);
  assert.throws(() => gate.mint(1), /TICKET_QUOTA_EXCEEDED/);
  assert.equal(gate.cancel(a, 1), true);
  const c = gate.mint(1);
  assert.equal(gate.pendingCount, 2);
  assert.throws(() => gate.claimHostOnly(c, 2), /STALE_ACTOR_GENERATION/);
  assert.equal(gate.pendingCount, 2, "wrong-generation claim cannot consume ticket");
  assert.equal(gate.retire(1), 2);
  assert.throws(() => gate.retire(2), /STALE_ACTOR_GENERATION/);
  assert.throws(() => gate.claimHostOnly(b, 1), /STALE_OR_REPLAYED/);
  gate.activate(2);
  assert.equal(gate.pendingCount, 0);
});

test("supervisor revokes host tickets before typed terminal restart and denies old resumes", {
  timeout: 30000
}, async () => {
  const f = hostPoolFixture();
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(f.pool, wasmPlaceholder, {
      expectedSha256: approved, maxRestarts: 1
    });
    const first = supervisor.current();
    const old = supervisor.issueHostContinuationTicket();
    assert.equal(supervisor.status.hostContinuationTicketsPending, 1);
    assert.throws(() => supervisor.resumeGuestContinuation(old),
      /ATTO_GUEST_SUSPEND_RESUME_NOT_IMPLEMENTED/);
    f.control();
    assert.equal(supervisor.status.hostContinuationTicketsPending, 0,
      "old authority must retire before replacement can be published");
    const next = await supervisor.whenReady();
    assert.equal(next.generation, 2);
    assert.equal(f.issued.length, 2);
    await assert.rejects(first.send(1n), /STALE_ACTOR_GENERATION/);
    assert.throws(() => supervisor.claimHostContinuationTicket(old), /STALE_OR_REPLAYED/);
    assert.throws(() => supervisor.resumeGuestContinuation(old), /STALE_OR_REPLAYED/);
    const current = supervisor.issueHostContinuationTicket();
    assert.equal(supervisor.claimHostContinuationTicket(current).guestResumeAuthorized,
      false);
    assert.equal(supervisor.status.guestContinuationResumeImplemented, false);
  } finally {
    await supervisor?.close();
    f.restore();
    await f.pool.close();
  }
});

test("host continuation mint/claim are rejected immediately on explicit STOP", {
  timeout: 30000
}, async () => {
  const f = hostPoolFixture();
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(f.pool, wasmPlaceholder, {
      expectedSha256: approved
    });
    const ticket = supervisor.issueHostContinuationTicket();
    const stopping = supervisor.current().stop();
    assert.equal(supervisor.status.hostContinuationTicketsPending, 0);
    assert.throws(() => supervisor.issueHostContinuationTicket(), /STALE_ACTOR_GENERATION/);
    assert.throws(() => supervisor.resumeGuestContinuation(ticket), /STALE_OR_REPLAYED/);
    await stopping;
    assert.equal(supervisor.status.phase, "stopped");
  } finally {
    await supervisor?.close();
    f.restore();
    await f.pool.close();
  }
});

test("host continuation tickets fail closed on unexpected trap and carrier retirement", {
  timeout: 30000
}, async () => {
  for (const mode of ["WASM_UNREACHABLE_V1", "CARRIER_RETIRED"]) {
    const f = hostPoolFixture();
    let supervisor;
    try {
      supervisor = await SupervisedPooledActor.start(f.pool, wasmPlaceholder, {
        expectedSha256: approved, maxRestarts: 2
      });
      const ticket = supervisor.issueHostContinuationTicket();
      if (mode === "CARRIER_RETIRED") {
        const latest = f.issued.at(-1);
        latest.onTerminalControl(Object.freeze({
          schemaVersion: 1,
          kind: "ACTOR_CARRIER_TERMINAL_CONTROL",
          reason: "CARRIER_RETIRED", actorId: latest.id,
          actorRetired: true, carrierRetained: false,
          physicalExitConfirmed: true
        }));
      } else f.control(mode);
      assert.equal(supervisor.status.hostContinuationTicketsPending, 0);
      assert.equal(supervisor.status.restarts, 0);
      assert.throws(() => supervisor.resumeGuestContinuation(ticket), /STALE_OR_REPLAYED/);
      assert.throws(() => supervisor.current(), /supervised actor is not active/);
    } finally {
      await supervisor?.close();
      f.restore();
      await f.pool.close();
    }
  }
});

test("closing supervisor fences all pending host continuation tickets, even before STOP settles", {
  timeout: 30000
}, async () => {
  const f = hostPoolFixture();
  let supervisor;
  try {
    supervisor = await SupervisedPooledActor.start(f.pool, wasmPlaceholder, {
      expectedSha256: approved
    });
    const ticket = supervisor.issueHostContinuationTicket();
    const first = supervisor.close(), second = supervisor.close();
    assert.strictEqual(first, second);
    assert.equal(supervisor.status.hostContinuationTicketsPending, 0);
    assert.throws(() => supervisor.resumeGuestContinuation(ticket), /STALE_OR_REPLAYED/);
    await first;
    assert.equal(supervisor.status.phase, "closed");
  } finally {
    await supervisor?.close();
    f.restore();
    await f.pool.close();
  }
});
