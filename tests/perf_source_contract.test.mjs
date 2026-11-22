import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const perf=readFileSync(new URL('../stdlib/perf.atto',import.meta.url),'utf8');
const ids=readFileSync(new URL('../stdlib/perf_ids.atto',import.meta.url),'utf8');
const alloc=readFileSync(new URL('../stdlib/alloc/perf_trace_buffer.atto',import.meta.url),'utf8');
const no_comments=source=>source.replace(/\/\/[^\n]*/g,'');

test('static probe IDs align with Java/CorePerf registry and optional-JIT manifest',()=>{
  const records=[...ids.matchAll(/pub fnc ([a-z0-9_]+)\(\) -> int \{ return (\d+); \}/g)];
  assert.deepEqual(records.map(x=>Number(x[2])),[23,24,25,26,27,28,29]);
  assert.equal(new Set(records.map(x=>x[1])).size,7);
});
test('disabled clock path returns without monotonic clock access',()=>{
  const begin=perf.split('pub fnc begin_ns')[1].split('pub fnc duration_ns')[0];
  const duration=perf.split('pub fnc duration_ns')[1].split('pub fnc should_sample')[0];
  assert.ok(begin.indexOf('if !enabled')>=0 && begin.indexOf('if !enabled')<begin.indexOf('process.monotonic_ns()'));
  assert.ok(duration.indexOf('if started_ns <= 0')>=0 && duration.indexOf('if started_ns <= 0')<duration.indexOf('process.monotonic_ns()'));
  assert.match(duration,/finished_ns < started_ns/);
});
test('sample decision rejects unknown or excessive divisors before modulo',()=>{
 const sample=perf.split('pub fnc should_sample')[1];
 assert.match(sample,/every_n < 1 \|\| every_n > 65536/);
 assert.ok(sample.indexOf('every_n < 1')<sample.indexOf('sample_key % every_n'));
});
test('buffer is actor-owned and finite, saturating drop count',()=>{
 assert.match(alloc,/let mut Array<Event> events/);
 assert.match(alloc,/capacity < 1 \|\| capacity > 65536/);
 assert.match(alloc,/self.events.size >= self.capacity/);
 assert.match(alloc,/self.dropped < 2147483647/);
 assert.match(alloc,/pub fnc buffer\(int capacity\)/);
});
test('disabled record path branches before any new Event allocation',()=>{
 const rec=alloc.split('pub record(mut self)')[1].split('pub record_span')[0];
 assert.ok(rec.indexOf('if !enabled')>=0 && rec.indexOf('if !enabled')<rec.indexOf('new Event('));
 const span=alloc.split('pub record_span')[1].split('pub count()')[0];
 assert.ok(span.indexOf('if !enabled')>=0 && span.indexOf('if !enabled')<span.indexOf('self.record('));
 assert.doesNotMatch(no_comments(alloc),/process\.|stdio\.|println|spawn|interop\.|eval\(/);
});
test('no producer-side export or runtime compiler in perf modules',()=>{
 for(const src of [no_comments(perf),no_comments(alloc),no_comments(ids)])
   assert.doesNotMatch(src,/stdio\.|println|http\.|tcp\.|eval\(|runtime_jit|source_compile/);
});
