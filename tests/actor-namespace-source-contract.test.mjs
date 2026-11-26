// Cross-backend fixture admission only. No compilation, Wasm or runtime PASS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const smoke=read('stdlib/actor/guest_smoke.atto');
const edges=read('stdlib/actor/guest_edges.atto');
const standalone=read('stdlib/actor/guest_namespace_only.atto');
const probes=[
  ['contracts/std-actor-v1/namespace-implicit-import.reject.atto','E_UNBOUND'],
  ['contracts/std-actor-v1/namespace-duplicate.reject.atto','E_DUPLICATE'],
  ['contracts/std-actor-v1/namespace-after-declaration.reject.atto','E_SYNTAX']
];
const guards=source=>[...source.matchAll(/^([ \t]*)if (.+?) then return (\d+); fi[ \t]*$/gm)]
  .map(m=>Number(m[3]));

test('namespace-only guest is pure and has no implicit imports or runtime authority',()=>{
  assert.match(standalone,/^use namespace std\.actor\.local_only;/m);
  assert.doesNotMatch(standalone,/^\s*import\b/m);
  assert.doesNotMatch(standalone,/^\s*(?:define|declare)\s+actor\b/m);
  assert.match(standalone,/pub fnc main\(\): int \{ return add_two\(40\); \}/);
  assert.match(standalone,/return add_two\(40\)/);
});

test('guard fixtures preserve all distinct failure exits and six compiled mutation targets',()=>{
  const a=guards(smoke),b=guards(edges);
  assert.equal(a.length,34);
  assert.equal(new Set(a).size,34);
  assert.equal(b.length,133);
  assert.equal(new Set(b).size,133);
  assert.deepEqual([a[0],a[Math.floor(a.length/2)],a.at(-1)],[1,18,34]);
  assert.deepEqual([b[0],b[Math.floor(b.length/2)],b.at(-1)],[100,166,232]);
  for(const source of [smoke,edges]) {
    assert.match(source,/use namespace std\.actor\./);
    assert.match(source,/from "\.\/policy\.atto";/);
    assert.match(source,/return 42;/);
  }
});

test('three namespace fraud probes demand exact compiler-negative codes',()=>{
  const byCode=probes.map(([file,code])=>{
    const source=read(file);
    assert.match(source,new RegExp('expect-error: '+code+'\\b'));
    assert.match(source,/use namespace/);
    assert.doesNotMatch(source,/^\s*import .*from "\.\/policy\.atto"/m,
      'no forged namespace import may borrow the actor policy file');
    return source;
  });
  assert.equal((byCode[1].match(/use namespace/g)||[]).length,2);
  assert.ok(byCode[2].indexOf('pub fnc main')<byCode[2].indexOf('use namespace'),
    'misplaced namespace must appear after a declaration');
  assert.match(byCode[0],/\bactor_mailbox_admissible\(/);
});

test('core Future receipts reject post-await use, live loans, repeat takes and guest forgery',()=>{
  const scenarios=[
    ['contracts/std-actor-v1/future-use-after-await.reject.atto','E_MOVED',/return receipt;/],
    ['contracts/std-actor-v1/future-loan-across-await.reject.atto','E_BORROW',/borrow! receipt;[\s\S]*return await receipt;/],
    ['contracts/std-actor-v1/future-take-then-await.reject.atto','E_MOVED',/take! receipt;[\s\S]*return await receipt;/],
    ['contracts/std-actor-v1/future-forged-constructor.reject.atto','E_RESERVED',/new ActorFuture<int>\(\)/]
  ];
  for(const [path,diagnostic,proof] of scenarios) {
    const source=read(path);
    assert.match(source,new RegExp('expect-error: '+diagnostic+'\\b'));
    assert.match(source,/use namespace std\.actor\./);
    assert.match(source,proof);
    if(diagnostic!=='E_RESERVED')assert.match(source,/take! ActorFuture<int> receipt/);
  }
});
