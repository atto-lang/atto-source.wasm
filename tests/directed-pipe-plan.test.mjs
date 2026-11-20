import test from 'node:test';
import assert from 'node:assert/strict';
import {planDirectedPipe,checkUnicastDirectedPipes} from '../src/directed-pipe-plan.mjs';
import {ActorPipelinePolicy} from '../src/actor-pipeline-policy.mjs';

const producer = Object.freeze({id:'producer',type:'Producer',tenant:'tenant-A',
  role:'duplex',inbound:'int',outbound:'int'});
const consumer = Object.freeze({id:'consumer',type:'Consumer',tenant:'tenant-A',
  role:'writable',inbound:'int',outbound:''});
const transform = Object.freeze({id:'transform',type:'Transform',tenant:'tenant-A',
  role:'transform',inbound:'int',outbound:'string'});
const stringConsumer = Object.freeze({...consumer,id:'strings',inbound:'string'});

test('named ActorRef pipe and reverse-written rpipe have identical DATA edges',()=>{
 const a=planDirectedPipe([producer,consumer],'pipe');
 const b=planDirectedPipe([consumer,producer],'rpipe');
 assert.deepEqual(a.edges,b.edges);
 assert.deepEqual(a.edges,[{source:'producer',target:'consumer',payload:'int'}]);
 assert.equal(a.selector.forward('producer').target,'consumer');
 assert.equal(b.selector.forward('producer').target,'consumer');
 assert.deepEqual(b.writtenStages.map(x=>x.id),['consumer','producer']);
 assert.deepEqual(b.flowIndices,[1,0]);
 assert.throws(()=>b.selector.forward('consumer'),/no downstream/);
});

test('rpipe reverses lexical stage order, not transform direction or payload types',()=>{
 const f=planDirectedPipe([producer,transform,stringConsumer],'pipe');
 const r=planDirectedPipe([stringConsumer,transform,producer],'rpipe');
 assert.deepEqual(f.edges,r.edges);
 assert.deepEqual(f.edges.map(x=>x.payload),['int','string']);
});

test('two source-to-sink spellings are NOT reverse DATA or implicit fan-out',()=>{
 const a=planDirectedPipe([producer,consumer],'pipe');
 const b=planDirectedPipe([consumer,producer],'rpipe');
 assert.deepEqual(a.edges,b.edges);
 assert.throws(()=>new ActorPipelinePolicy(a.stages,[...a.edges,...b.edges]),/duplicate pipeline edge/);
});

test('rejects missing emit, reverse source-only/sink-only misuse and mismatched types',()=>{
 const noEmit={...producer,role:'writable',outbound:''};
 assert.throws(()=>planDirectedPipe([noEmit,consumer],'pipe'));
 assert.throws(()=>planDirectedPipe([producer,noEmit],'rpipe'));
 assert.throws(()=>planDirectedPipe([producer,stringConsumer],'pipe'),/type/);
 assert.throws(()=>planDirectedPipe([consumer,producer],'pipe'));
});

test('direct cross-tenant pipes cannot acquire an implicit mailbox or socket capability',()=>{
 const foreign={...consumer,tenant:'tenant-B'};
 assert.throws(()=>planDirectedPipe([producer,foreign],'pipe'),/cross-tenant pipe denied/);
 assert.throws(()=>planDirectedPipe([foreign,producer],'rpipe'),/cross-tenant pipe denied/);
});

test('refuses getters, inherited metadata, sparse lists, Unicode and invalid operator',()=>{
 let calls=0;
 const evil={...producer};
 Object.defineProperty(evil,'tenant',{get(){++calls;return 'tenant-A';}});
 assert.throws(()=>planDirectedPipe([evil,consumer],'pipe'),/own data/);
 assert.equal(calls,0);
 assert.throws(()=>planDirectedPipe([Object.create(producer),consumer],'pipe'),/own data/);
 assert.throws(()=>planDirectedPipe(new Array(2),'pipe'),/own data/);
 assert.throws(()=>planDirectedPipe([producer,consumer],'|>'),/direction/);
 assert.throws(()=>planDirectedPipe([{...producer,id:'bad\u202e'},consumer],'pipe'),/unsafe/);
 assert.throws(()=>planDirectedPipe([{...producer,tenant:'\ud800'},consumer],'pipe'),/Unicode/);
 assert.throws(()=>planDirectedPipe([producer,consumer,consumer],'pipe'),/duplicate/);
 assert.throws(()=>planDirectedPipe([producer],'pipe'),/budget/);
});

test('plan is immutable and never starts guest work or exposes supervisor CONTROL',()=>{
 const p=planDirectedPipe([producer,consumer],'pipe');
 assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(p.edges));
 assert.ok(Object.isFrozen(p.edges[0])); assert.ok(Object.isFrozen(p.stages[0]));
 assert.equal(typeof p.send,'undefined');
 assert.equal(typeof p.start,'undefined');
 assert.equal(typeof p.supervisor,'undefined');
});

test('unicast preflight rejects implicit fan-in and duplicate direction, allows disjoint ports',()=>{
 const first=planDirectedPipe([producer,consumer],'pipe');
 const reverse=planDirectedPipe([consumer,producer],'rpipe');
 assert.throws(()=>checkUnicastDirectedPipes([first,reverse]),/E_PIPE_DUPLICATE_EDGE/);
 const alternateProducer={...producer,id:'other_producer'};
 const inbound=planDirectedPipe([alternateProducer,consumer],'pipe');
 assert.throws(()=>checkUnicastDirectedPipes([first,inbound]),/E_PIPE_INPUT_OCCUPIED/);
 const otherConsumer={...consumer,id:'other_consumer'};
 const outbound=planDirectedPipe([producer,otherConsumer],'pipe');
 assert.throws(()=>checkUnicastDirectedPipes([first,outbound]),/E_PIPE_OUTPUT_OCCUPIED/);
 const independent=planDirectedPipe([alternateProducer,otherConsumer],'pipe');
 assert.equal(checkUnicastDirectedPipes([first,independent]),true);
 assert.throws(()=>checkUnicastDirectedPipes([{...first}]),/E_PIPE_PLAN_CAPABILITY/);
});
