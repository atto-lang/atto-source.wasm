// SOURCE-CONTRACT tests only. These do not claim executed Atto guest code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../stdlib/std/io.atto", import.meta.url), "utf8");
test("native .atto std/io API and fail-closed adapter boundary", () => {
  for (const required of [
    "define module io as", "pub define class ReadChunk", "pub define class Cursor",
    "pub define class Sink", "pub define class BytePipe", "pub read(mut self)",
    "pub read_exact(mut self)", "pub write(mut self)", "pub write_all(mut self)",
    "pub try_read(mut self)", "pub try_read_exact(mut self)",
    "pub try_write(mut self)", "pub try_write_all(mut self)",
    "pub close_writer(mut self)", "pub fnc byte_pipe",
    "return Err(\"WouldBlock\")", "return Err(\"UnexpectedEof\")",
    "return Err(\"InvalidByte\")", "return Ok(new ReadChunk",
  ]) assert.ok(source.includes(required), "missing source contract: " + required);
  assert.ok(!/\b(java|System\.io|ffi|Deno|Node|fetch\(|FileInputStream|Socket)\b/.test(source),
    "std/io memory implementation must not call a host I/O API");
});
class ModelPipe {
  constructor(cap) { assert.ok(cap >= 1 && cap <= 1048576); this.cap = cap; this.data = []; this.closed = false; }
  write(bytes, exact = false) {
    if (this.closed) return "Closed";
    if (bytes.length > 65536) return "InvalidWriteSize";
    if (bytes.some(b => !Number.isInteger(b) || b < 0 || b > 255)) return "InvalidByte";
    if (!bytes.length) return 0;
    const space = this.cap - this.data.length;
    if (!space || (exact && space < bytes.length)) return "WouldBlock";
    const n = Math.min(space, bytes.length);
    this.data.push(...bytes.slice(0, n));
    return n;
  }
  read(n, exact = false) {
    if (n < (exact ? 0 : 1) || n > 65536) return "InvalidReadSize";
    if (exact && this.data.length < n) return this.closed ? "UnexpectedEof" : "WouldBlock";
    if (!exact && !this.data.length) return this.closed ? {bytes:[],eof:true} : "WouldBlock";
    const got = this.data.splice(0, n);
    return exact ? got : {bytes:got,eof:false};
  }
}
test("model: short write, FIFO after wrap, backpressure and no silent truncation", () => {
  const p = new ModelPipe(3);
  assert.equal(p.write([1,2]), 2);
  assert.deepEqual(p.read(1), {bytes:[1],eof:false});
  assert.equal(p.write([3,4,5]), 2);
  assert.deepEqual(p.read(3), {bytes:[2,3,4],eof:false});
  assert.equal(p.read(1), "WouldBlock");
});
test("model: closed writer drains buffered data before EOF", () => {
  const p = new ModelPipe(2); p.write([7,8]); p.closed = true;
  assert.equal(p.write([9]), "Closed");
  assert.deepEqual(p.read(5), {bytes:[7,8],eof:false});
  assert.deepEqual(p.read(5), {bytes:[],eof:true});
  assert.equal(p.read(1,true), "UnexpectedEof");
});
test("model: invalid byte, exact operation failure and zero-size semantics", () => {
  const p = new ModelPipe(2);
  assert.equal(p.write([1,300]), "InvalidByte");
  assert.deepEqual(p.data, []);
  assert.equal(p.write([]), 0);
  assert.equal(p.read(0), "InvalidReadSize");
  assert.equal(p.write([1,2,3],true), "WouldBlock");
  assert.deepEqual(p.data, []);
  assert.equal(p.write([1,2]), 2);
  assert.equal(p.read(3,true), "WouldBlock");
  assert.deepEqual(p.data, [1,2]);
  assert.deepEqual(p.read(0,true), []);
});
test("model: randomized FIFO conservation under partial transfers", () => {
  let seed = 27644437;
  const random = () => ((seed = (Math.imul(seed,1664525) + 1013904223) >>> 0));
  const p = new ModelPipe(17);
  let expected = []; let next = 0;
  for (let i = 0; i < 3000; i++) {
    if (random() % 3 !== 0) {
      const bytes = Array.from({length: random()%11}, () => (next++ % 256));
      const result = p.write(bytes);
      if (typeof result === "number") expected.push(...bytes.slice(0,result));
      else assert.equal(result,"WouldBlock");
    } else {
      const result = p.read(1 + random()%10);
      if (typeof result !== "string") assert.deepEqual(result.bytes,expected.splice(0,result.bytes.length));
      else assert.equal(result,"WouldBlock");
    }
    assert.deepEqual(p.data,expected);
    assert.ok(p.data.length <= 17);
  }
});
