import test from "node:test";
import assert from "node:assert/strict";
import {SupervisorStopLedger} from "../src/supervisor-stop-ledger.mjs";

const newLedger=(supervisor="supervisor",group="group")=>
  new SupervisorStopLedger({supervisor,group});

test("supervisor group and physical actor IDs cannot contain Unicode format or control bytes",()=>{
  for(const code of ["\u200b","\u00ad","\u2060","\u061c","\ufeff","\u0085","\n"]){
    for(const field of ["supervisor","group"]){
      const opts={supervisor:"supervisor",group:"group"};
      opts[field]="x"+code+"y";
      assert.throws(()=>newLedger(opts.supervisor,opts.group),
        /invalid supervisor\/group/);
    }
    assert.throws(()=>newLedger().register({actorId:"child"+code+"7",incarnation:1}),
      /invalid physical actor identity/);
  }
});

test("UTF-8 byte length and malformed surrogate identities fail without consuming child capacity",()=>{
  const ledger=newLedger("supérvisor","groupe");
  for(const id of ["🚀".repeat(33),"bad\ud800","bad\udc00"])
    assert.throws(()=>ledger.register({actorId:id,incarnation:1}),
      /invalid physical actor identity/);
  const child=ledger.register({actorId:"child_🚀",incarnation:1});
  ledger.assert_physically_finalized(child);
  const ticket=ledger.reserve_stop(child);
  ledger.claim_host_invocation(ticket);
  ledger.mark_applied(ticket);
  ledger.acknowledge_applied(ticket);
  assert.equal(ledger.snapshot(child).phase,"stopped");
});
