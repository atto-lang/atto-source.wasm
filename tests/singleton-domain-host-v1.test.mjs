import test from 'node:test';
import assert from 'node:assert/strict';
import { isMainThread, Worker, parentPort, workerData } from 'node:worker_threads';
import { SingletonDomainHostV1, singleton_key } from '../src/singleton-domain-host-v1.mjs';

// Actual worker threads receive copies. They never acquire raw host pointers
// or coordinator CONTROL rights.
if (!isMainThread) {
  const copy = workerData.snapshot;
  copy.nested.count = 77;
  parentPort.postMessage({
    observed: copy.nested.count,
    nominal_symbol: workerData.symbol.tag === 'ores.symbol.v1'
      && workerData.symbol.name === '#ready',
  });
}

if (isMainThread) {
  test('canonical namespace/module/declaration, detached immutable fields and tenant isolation', () => {
    const host = new SingletonDomainHostV1();
    const source = {nested: {count: 1}, list: [1,2,3]};
    const a = host.publish_const('tenant-A','pkg','Settings',source);
    const b = host.publish_const('tenant-A','pkg','Settings',{list:[1,2,3],nested:{count:1}});
    assert.equal(a,b);
    assert.equal(Object.isFrozen(a.nested),true);
    source.nested.count = 99;
    assert.equal(a.nested.count,1);
    assert.notEqual(new SingletonDomainHostV1().publish_const(
      'tenant-A','pkg','Settings',{list:[1,2,3],nested:{count:1}}),a);
    assert.notEqual(host.publish_const('tenant-B','pkg','Settings',source),a);
    assert.notEqual(singleton_key('tenant-A','pkg','Settings'),singleton_key('tenant-B','pkg','Settings'));
    assert.throws(()=>host.publish_const('tenant-A','pkg','Settings',{nested:{count:6}}),/schema mismatch/);
  });

  test('malicious alias, accessor, circular, numeric and quota admission fail closed', () => {
    const host = new SingletonDomainHostV1({max_singletons:1});
    const poison = {};
    Object.defineProperty(poison,'x',{enumerable:true,get(){throw Error('getter should not execute')}});
    assert.throws(()=>host.publish_const('T','m','S',poison),/accessor/);
    const cycle={};cycle.self=cycle;
    assert.throws(()=>host.publish_const('T','m','S',cycle),/cyclic/);
    assert.throws(()=>host.publish_const('T','m','S',{bad:Infinity}),/number/);
    assert.throws(()=>host.publish_const('T','m','S',{bad:()=>42}),/unproved/);
    assert.throws(()=>host.publish_const('T','m','S',Object.assign(Object.create({admin:true}),{a:1})),/nonplain/);
    host.publish_const('T','m','S',{value:1});
    assert.throws(()=>host.publish_const('T','m','Other',{value:2}),/quota/);
    assert.throws(()=>singleton_key('x/..','m','S'),/invalid/);
  });

  test('two logical readers overlap, one writer waits and late readers cannot bypass it', async () => {
    const d=new SingletonDomainHostV1();
    const owner=d.mint_actor_turn(1,1,0), r1=d.mint_actor_turn(2,1,1),r2=d.mint_actor_turn(3,1,1);
    const writer=d.mint_actor_turn(4,1,1),late=d.mint_actor_turn(5,1,1);
    const region=d.region('T','mod','Counter',owner,{value:0});
    const a=await region.acquire(r1,region.grant(owner,r1,'read'));
    const b=await region.acquire(r2,region.grant(owner,r2,'read'));
    assert.equal(region.reader_count,2);
    let writerDone=false;
    const wp=region.acquire(writer,region.grant(owner,writer,'write')).then(x=>{writerDone=true;return x;});
    const lp=region.acquire(late,region.grant(owner,late,'read'));
    assert.equal(region.pending_count,2);
    assert.throws(()=>a.write(r1,x=>x),/exclusive/);
    a.release(r1);await Promise.resolve();
    assert.equal(writerDone,false);
    b.release(r2);
    const w=await wp;
    assert.equal(region.writer_count,1);
    assert.equal(writerDone,true);
    assert.throws(()=>a.read(r1),/revoked/);
    w.write(writer,old=>({value:old.value+1}));
    w.release(writer);
    const l=await lp;
    assert.equal(l.read(late).value,1);
    l.release(late);
    assert.equal(region.reader_count,0);
    assert.equal(region.writer_count,0);
  });

  test('queued cancellation is atomic and does not bypass an earlier writer', async () => {
    const d=new SingletonDomainHostV1();
    const o=d.mint_actor_turn(6,1,0),a=d.mint_actor_turn(7,1,1),b=d.mint_actor_turn(8,1,1),c=d.mint_actor_turn(9,1,1);
    const r=d.region('T','pkg','Cancel',o,{number:5});
    const read=await r.acquire(a,r.grant(o,a,'read'));
    const abort=new AbortController();
    const pending=r.acquire(b,r.grant(o,b,'write'),{signal:abort.signal});
    const later=r.acquire(c,r.grant(o,c,'read'));
    assert.equal(r.pending_count,2);
    abort.abort();
    await assert.rejects(pending,/cancelled/);
    const after=await later;
    assert.equal(r.reader_count,2);
    after.release(c);read.release(a);
    assert.equal(r.reader_count,0);
  });

  test('stale writer release inside callback never publishes and physically fences successor', async () => {
    const d=new SingletonDomainHostV1();
    const o=d.mint_actor_turn(10,1,0), next=d.mint_actor_turn(11,1,1);
    const r=d.region('T','pkg','Guard',o,{count:0});
    const a=await r.acquire(o,r.grant(o,o,'write'));
    let granted=false;
    const p=r.acquire(next,r.grant(o,next,'write')).then(x=>{granted=true;return x;});
    assert.throws(()=>a.write(o,old=>{
      a.release(o);
      assert.equal(granted,false);
      assert.equal(r.pending_count,1);
      return {count:old.count+100};
    }),/revoked/);
    const successor=await p;
    assert.equal(successor.read(next).count,0);
    assert.throws(()=>successor.write(next,async()=>({count:42})),/await/);
    assert.equal(successor.read(next).count,0);
    successor.write(next,x=>({count:x.count+1}));
    successor.release(next);
  });

  test('STOP revokes actor authority but retains physical loans until release', async () => {
    const d=new SingletonDomainHostV1();
    const o=d.mint_actor_turn(12,1,0),r1=d.mint_actor_turn(13,1,1);
    const region=d.region('T','pkg','Stop',o,{value:1});
    const lease=await region.acquire(r1,region.grant(o,r1,'read'));
    region.stop(o);
    assert.equal(region.physically_retired,false);
    assert.throws(()=>lease.read(r1),/revoked/);
    lease.release(r1);
    assert.equal(region.physically_retired,true);
    await assert.rejects(region.acquire(r1,Object.freeze({})),/stale/);
  });

  test('quiescent owner transfer invalidates previous grants and foreign principals', async () => {
    const d=new SingletonDomainHostV1();
    const old=d.mint_actor_turn(14,1,0),newOwner=d.mint_actor_turn(15,2,0),r=d.mint_actor_turn(16,1,1);
    const region=d.region('T','pkg','Transfer',old,{a:1});
    const stale=region.grant(old,r,'read');
    const active=await region.acquire(old,region.grant(old,old,'read'));
    assert.throws(()=>region.transfer_owner(old,newOwner),/quiescence/);
    active.release(old);
    region.transfer_owner(old,newOwner);
    await assert.rejects(region.acquire(r,stale),/stale/);
    assert.throws(()=>region.grant(old,r,'read'),/only singleton owner/);
    assert.throws(()=>region.grant(newOwner,new SingletonDomainHostV1().mint_actor_turn(1,1,1),'read'),/foreign/);
  });

  test('nominal Symbol catalog is bounded, NFC aware and private symbols cannot cross untrusted workers', () => {
    const d=new SingletonDomainHostV1({max_symbols:2});
    const ready=d.intern_symbol('#ready');
    assert.equal(d.intern_symbol('#ready'),ready);
    assert.notEqual(ready,'#ready');
    assert.equal(d.resolve_symbol({tag:'ores.symbol.v1',scope:'process',name:'#ready'}),ready);
    const privateSym=d.intern_symbol('#secret',{scope:'private'});
    assert.throws(()=>d.resolve_symbol(privateSym),/private symbol transport/);
    assert.equal(d.resolve_symbol(privateSym,{trusted:true}),privateSym);
    assert.throws(()=>d.intern_symbol('#third'),/quota/);
    assert.throws(()=>d.resolve_symbol({tag:'ores.symbol.v1',scope:'process',name:'#unknown'}),/unknown symbol/);
    assert.throws(()=>d.intern_symbol('#bad\u0301'),/invalid symbol/);
  });

  test('two real Node workers receive independent snapshots and nominal Symbol descriptors', async () => {
    const domain=new SingletonDomainHostV1();
    const original=domain.publish_const('tenant','pkg','Shared',{nested:{count:0}});
    const symbol=domain.intern_symbol('#ready');
    async function dispatch() {
      const worker=new Worker(new URL(import.meta.url), {
        workerData:{snapshot:structuredClone(original),symbol:structuredClone(symbol)}
      });
      try {
        return await new Promise((resolve,reject)=>{
          worker.once('message',resolve);worker.once('error',reject);
          worker.once('exit',code=>{if(code!==0)reject(new Error('worker failed '+code));});
        });
      } finally {await worker.terminate();}
    }
    const [one,two]=await Promise.all([dispatch(),dispatch()]);
    assert.deepEqual(one,{observed:77,nominal_symbol:true});
    assert.deepEqual(two,{observed:77,nominal_symbol:true});
    assert.equal(original.nested.count,0,'host canonical singleton never aliases transferred worker memory');
  });
}
