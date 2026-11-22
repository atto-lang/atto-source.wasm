import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {atto_pure} from './atto_pure_subset.mjs';

// Restricted Atto syntax parser. Source text never executes as JavaScript.
// These checks do NOT establish guest execution or target compiler support.
const src=readFileSync(new URL('../stdlib/log.atto', import.meta.url),'utf8');
const valid_severity=atto_pure(src,'valid_severity');
const valid_threshold=atto_pure(src,'valid_threshold',{valid_severity});
const enabled=atto_pure(src,'enabled',{valid_severity,valid_threshold});
const severity_name=atto_pure(src,'severity_name');
const sink_byte_budget_ok=atto_pure(src,'sink_byte_budget_ok');

test('flat source namespace, no runtime module or host logger',()=>{
  assert.match(src,/^namespace log;$/m);
  assert.doesNotMatch(src,/define module|define namespace|java\.|System\.|console\.|ffi\.|stdio\.|spawn|await/);
  for(const f of ['valid_severity','valid_threshold','enabled','severity_name','sink_byte_budget_ok']){
    assert.match(src,new RegExp('pub fnc '+f+'\\('));
  }
});
test('severity names and malformed codes fail closed',()=>{
  const levels=[10,20,30,40,50,60], labels=['TRACE','DEBUG','INFO','WARN','ERROR','FATAL'];
  assert.deepEqual(levels.map(v=>severity_name(v)),labels);
  for(let n=-5;n<=80;n++){
    assert.equal(valid_severity(n),levels.includes(n));
    assert.equal(valid_threshold(n),levels.includes(n)||n===70);
    if(!levels.includes(n))assert.equal(severity_name(n),'UNKNOWN');
  }
});
test('severity-threshold matrix includes OFF',()=>{
  const levels=[10,20,30,40,50,60];
  for(let severity=-5;severity<=80;severity++){
    for(let threshold=-5;threshold<=80;threshold++){
      const wanted=levels.includes(severity)&&levels.includes(threshold)&&severity>=threshold;
      assert.equal(enabled(severity,threshold),wanted,
        'severity='+severity+' threshold='+threshold);
    }
  }
});
test('overflow safe sink budget given authenticated UTF-8 sizes',()=>{
  assert.equal(sink_byte_budget_ok(0,65536,65536,8388608),true);
  assert.equal(sink_byte_budget_ok(8388607,1,65536,8388608),true);
  assert.equal(sink_byte_budget_ok(8388608,1,65536,8388608),false);
  assert.equal(sink_byte_budget_ok(0,65537,65536,8388608),false);
  for(const bad of [[-1,1,1,1],[0,-1,1,1],[0,1,-1,1],[0,1,1,-1],[2,0,1,1]])
    assert.equal(sink_byte_budget_ok(...bad),false);
  const max=Number.MAX_SAFE_INTEGER;
  assert.equal(sink_byte_budget_ok(max-1,1,1,max),true);
  assert.equal(sink_byte_budget_ok(max-1,2,2,max),false);
  assert.match(src,/max_pending_bytes - queued_bytes/);
});
test('malicious source cannot run host code',()=>{
  assert.throws(()=>atto_pure('pub fnc evil() -> bool { process.exit(1);\n}','evil'));
  assert.throws(()=>atto_pure('pub fnc evil() -> bool { return globalThis;\n}','evil')());
  assert.throws(()=>atto_pure('pub fnc evil() -> bool { while true; do return true; fi\n}','evil'));
});
test('source mutation alters interpreter result',()=>{
  const mutated=src.replace('return severity >= threshold;','return severity < threshold;');
  const wrong=atto_pure(mutated,'enabled',{valid_severity,valid_threshold});
  assert.equal(enabled(40,30),true);
  assert.equal(wrong(40,30),false);
});
