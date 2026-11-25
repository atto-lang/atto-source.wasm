import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../core/perf_policy.atto',import.meta.url),'utf8');
const executable=src.replace(/\/\/[^\n]*/g,'');
const body=(start,stop)=>executable.split('pub fnc '+start)[1]?.split('pub fnc '+stop)[0]??'';
test('pure source contains the five required independently owned core functions',()=>{
 assert.match(executable,/define module core as/);
 for(const name of ['perf_valid_probe','perf_should_sample','perf_duration_ns','perf_can_record','perf_next_dropped'])
  assert.match(executable,new RegExp('pub fnc '+name+'\\('));
});
test('core admission has no runtime clocks, imports, heap, I/O or eval',()=>{
 assert.doesNotMatch(executable,/process\.|stdio\.|import |malloc|new Array|\bnew\b|eval\(|spawn|await |thread/);
});
test('sampling guards zero divisor before multiplication and never uses reserved percent',()=>{
 const sample=body('perf_should_sample','perf_duration_ns');
 assert.match(sample,/every_n < 1 \|\| every_n > 65536/);
 assert.ok(sample.indexOf('every_n < 1')<sample.indexOf('sample_key / every_n'));
 assert.match(sample,/\(sample_key \/ every_n\) \* every_n == sample_key/);
 assert.doesNotMatch(sample,/%/);
});
test('finite owner capacity and disabled path are checked before occupation',()=>{
 const cap=body('perf_can_record','perf_next_dropped');
 assert.match(cap,/!enabled/);
 assert.match(cap,/capacity < 1 \|\| capacity > 65536/);
 assert.match(cap,/occupied >= 0 && occupied < capacity/);
});
test('saturating drop count and monotonic-only elapsed math',()=>{
 const elapsed=body('perf_duration_ns','perf_can_record');
 assert.match(elapsed,/started_ns <= 0 \|\| finished_ns < started_ns/);
 assert.match(elapsed,/finished_ns - started_ns/);
 const drop=executable.split('pub fnc perf_next_dropped')[1];
 assert.match(drop,/dropped >= 2147483647/);
 assert.match(drop,/return dropped \+ 1/);
});
