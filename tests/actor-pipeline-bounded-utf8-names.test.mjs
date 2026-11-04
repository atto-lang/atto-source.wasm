import test from 'node:test';
import assert from 'node:assert/strict';
import {ActorPipelineSelector,routeKeySlot} from '../src/actor-pipeline-selector.mjs';

const create=(id,actorType='Producer')=>new ActorPipelineSelector([
  {id,actorType,role:'readable',inbound:'',outbound:'Event'},
  {id:'sink',actorType:'Sink',role:'writable',inbound:'Event',outbound:''}
],[{source:id,target:'sink',payload:'Event'}]);

test('actor identities use an exact 256-byte UTF-8 cap, not merely code-unit count',()=>{
  const exact='🌍'.repeat(64);
  assert.equal(create(exact).forward(exact).target,'sink');
  assert.throws(()=>create('🌍'.repeat(65)),/routing component byte budget/);
});

test('actor type names reject multibyte values exceeding the byte ceiling',()=>{
  assert.equal(create('source','中'.repeat(85)).forward('source').target,'sink');
  assert.throws(()=>create('source','中'.repeat(86)),/routing component byte budget/);
});

test('key routing accepts exactly 4096 UTF-8 bytes and rejects the next multibyte key',()=>{
  const atLimit='🌍'.repeat(1024);
  const slot=routeKeySlot(atLimit,4096);
  assert.ok(slot>=0 && slot<4096);
  assert.equal(routeKeySlot(atLimit,4096),slot,'stable FNV key assignment');
  assert.throws(()=>routeKeySlot('🌍'.repeat(1025),4096),/routing component byte budget/);
  assert.throws(()=>routeKeySlot('ready',0),/invalid downstream edge count/);
  assert.throws(()=>routeKeySlot('ready',4097),/invalid downstream edge count/);
});
