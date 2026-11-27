import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const bytes = readFileSync(process.argv[2]);
const module = new WebAssembly.Module(bytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
const { flat_machine_successor: lookup } = new WebAssembly.Instance(module).exports;
assert.equal(typeof lookup, 'function');
const expected = [[[-1,-1],[0,1]],[[1,-1],[-1,0]]];
let checks = 0;
const values = [-2147483648, -1, 0, 1, 2, 255, 256, 2147483647];
for (const graph of values) for (const node of values) for (const slot of values) {
    const want = graph >= 0 && graph < 2 && node >= 0 && node < 2 && slot >= 0 && slot < 2
        ? expected[graph][node][slot] : -2;
    assert.equal(lookup(graph,node,slot), want);
    checks++;
}
console.log(`${checks} wasm32 lookup assertions passed (hand-authored C witness, not Atto guest)`);
