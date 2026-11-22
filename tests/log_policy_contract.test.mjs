import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// SOURCE-EXTRACTED POLICY TEST. Not real Atto compilation, guest execution,
// native AOT, actor delivery, permission checking, or cross-compiler parity.
const src = readFileSync(new URL('../stdlib/log.atto', import.meta.url),'utf8');
function atto_pure(name, types, dependencies={}) {
  const re = new RegExp('pub fnc '+name+'\\(([^)]*)\\) -> '+types+' \\{([\\s\\S]*?)\\n\\}');
  const m=src.match(re);
  assert.ok(m,'missing '+name);
  const params=m[1].split(',').map(p=>p.trim().split(/\\s+/).at(-1));
  const body=m[2].replace(/\\bif\\s+([^;]+);\\s*do/g,(_,condition)=>'if ('+condition+') {')
    .replace(/\\bfi\\b/g,'}');
  assert.doesNotMatch(body,/\\b(?:await|spawn|rt|new|self|ffi)\\b/);
  const keys=Object.keys(dependencies);
  const fn=new Function(...keys,...params,'"use strict";\\n'+body);
  return (...args)=>fn(...keys.map(k=>dependencies[k]),...args);
}
const valid_severity=atto_pure('valid_severity','bool');
const valid_threshold=atto_pure('valid_threshold','bool',{valid_severity});
const enabled=atto_pure('enabled','bool',{valid_severity,valid_threshold});
const severity_name=atto_pure('severity_name','String');
const sink_byte_budget_ok=atto_pure('sink_byte_budget_ok','bool');

test('flat native log namespace, no runtime module or host logger',()=>{
  assert.match(src,/^namespace log;$/m);
  assert.doesNotMatch(src,/define module|define namespace|java\\.|System\\.|console\\.|ffi\\.|stdio\\.|spawn|await/);
  for(const f of ['valid_severity','valid_threshold','enabled','severity_name','sink_byte_budget_ok']){
    assert.match(src,new RegExp('pub fnc '+f+'\\('));
  }
});
test('canonical severities, labels and malformed codes fail closed',()=>{
  const names=['TRACE','DEBUG','INFO','WARN','ERROR','FATAL'];
  const levels=[10,20,30,40,50,60];
  assert.deepEqual(levels.map(severity_name), names);
  for(let level=-5;level<=80;level++){
    assert.equal(valid_severity(level),levels.includes(level));
    assert.equal(valid_threshold(level),levels.includes(level)||level===70);
    if(!levels.includes(level))assert.equal(severity_name(level),'UNKNOWN');
  }
});
test('threshold combinations and OFF',()=>{
  for(let severity=-5;severity<=80;severity++){
    for(let threshold=-5;threshold<=80;threshold++){
      const expect=[10,20,30,40,50,60].includes(severity)
        &&[10,20,30,40,50,60].includes(threshold)&&severity>=threshold;
      assert.equal(enabled(severity,threshold),expect,
        'severity='+severity+' threshold='+threshold);
    }
  }
});
test('trusted sink byte admission uses subtraction, not overflow-prone addition',()=>{
  assert.equal(sink_byte_budget_ok(0,65536,65536,8388608),true);
  assert.equal(sink_byte_budget_ok(8388607,1,65536,8388608),true);
  assert.equal(sink_byte_budget_ok(8388608,1,65536,8388608),false);
  assert.equal(sink_byte_budget_ok(0,65537,65536,8388608),false);
  for(const bad of [[-1,1,1,1],[0,-1,1,1],[0,1,-1,1],[0,1,1,-1],[2,0,1,1]]) {
    assert.equal(sink_byte_budget_ok(...bad),false);
  }
  const max=Number.MAX_SAFE_INTEGER;
  assert.equal(sink_byte_budget_ok(max-1,1,1,max),true);
  assert.equal(sink_byte_budget_ok(max-1,2,2,max),false);
  assert.match(src,/max_pending_bytes - queued_bytes/);
});
