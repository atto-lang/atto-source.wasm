// Host-only TCP + continuation ledger integration, not compiled guest await.
import test from "node:test";
import assert from "node:assert/strict";
import {createServer, createConnection} from "node:net";
import {once} from "node:events";
import {PinnedContinuationGate} from "../src/pinned-continuation-gate.mjs";
import {copyPrivateBytes, refreshPrivateMemoryView} from "../src/actor-frame-bytes.mjs";

for (const terminal of ["cancelled", "timed_out"]) {
  test(`loopback sibling progresses before ${terminal} operation receives a late reply`,
    {timeout: 5000}, async t => {
    const sockets = new Set();
    const server = createServer(socket => { sockets.add(socket); });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    async function connect() {
      const peer = once(server, "connection");
      const client = createConnection(server.address().port, "127.0.0.1");
      sockets.add(client);
      const [[remote]] = await Promise.all([peer, once(client, "connect")]);
      return {client, remote};
    }
    async function close({client, remote}) {
      const closed = Promise.all([once(client, "close"), once(remote, "close")]);
      client.destroy();
      await closed;
    }
    const a = await connect();
    const b = await connect();
    const ta = {actorId: 1, generation: 1, operationId: 1};
    const tb = {actorId: 2, generation: 1, operationId: 1};
    const ga = new PinnedContinuationGate(ta);
    const gb = new PinnedContinuationGate(tb);
    const ma = refreshPrivateMemoryView(new WebAssembly.Memory({initial: 1, maximum: 1}));
    const mb = refreshPrivateMemoryView(new WebAssembly.Memory({initial: 1, maximum: 1}));
    ma[0] = 11; mb[0] = 41;
    const loan = ga.acquire(ta, 1, "exclusive");
    assert.ok(loan);
    const aRequest = once(a.remote, "data");
    const aReply = once(a.client, "data");
    a.client.write(Buffer.from([1]));
    assert.deepEqual([...(await aRequest)[0]], [1]);
    assert.equal(ga.terminal, null);
    assert.equal(ga.claimResume(ta), false);
    assert.equal(gb.claimResume(ta), false);

    const bRequest = once(b.remote, "data");
    const bReply = once(b.client, "data");
    b.client.write(Buffer.from([2]));
    assert.deepEqual([...(await bRequest)[0]], [2]);
    b.remote.write(Buffer.from([42]));
    mb[0] = (await bReply)[0][0];
    assert.equal(gb.settle(tb, "success"), true);
    assert.equal(ga.terminal, null, "A remains pending while B progresses");
    await close(b);
    assert.equal(gb.brokerAcknowledge(tb), true);
    assert.equal(gb.claimResume(tb), true);
    assert.equal(gb.finishResume(tb), true);
    assert.equal(gb.tryRetire(tb), true);
    assert.equal(ma[0], 11);

    assert.equal(ga.settle(ta, terminal), true);
    assert.equal(ga.acquire(ta, 2, "shared"), null);
    assert.equal(ga.claimResume(ta), false);
    a.remote.write(Buffer.from([99]));
    assert.deepEqual([...(await aReply)[0]], [99]);
    assert.equal(ga.settle(ta, "success"), false, "late TCP reply cannot win");
    assert.equal(ga.terminal, terminal);
    assert.equal(ma[0], 11);
    await close(a);
    assert.equal(ga.brokerAcknowledge(ta), true);
    assert.equal(ga.claimResume(ta), true, "terminal cleanup claim only");
    assert.equal(ga.claimResume(ta), false);
    assert.equal(ga.finishResume(ta), true);
    assert.equal(ga.tryRetire(ta), false, "external loan still pins retirement");
    assert.equal(ga.release(ta, 1, loan), true);
    assert.equal(ga.release(ta, 1, loan), false);
    assert.equal(ga.tryRetire(ta), true);
    ma.fill(0);
    assert.deepEqual([...copyPrivateBytes(mb, 0, 1)], [42]);
    const fresh = {...ta, generation: 2};
    const replacement = new PinnedContinuationGate(fresh);
    assert.equal(replacement.settle(ta, "success"), false);
    assert.equal(replacement.claimResume(ta), false);
    assert.equal(replacement.terminal, null);
  });
}
