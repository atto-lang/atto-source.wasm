import test from "node:test";
import assert from "node:assert/strict";
import {rejectUnsupportedHeapContainerSource} from "../scripts/compile-ores.mjs";

const utf8 = source => Buffer.from(source, "utf8");

test("unlowered Box Arc Weak and resizable collections are rejected pre-compiler", () => {
  for (const source of [
    "pub fnc main():int{val Box<int> owner=Box<int>(42);return 42;}",
    "pub fnc main():int{val Arc<int> shared=Arc<int>(42);return 42;}",
    "pub fnc main():int{val Weak<int> weak=Weak<int>(42);return 42;}",
    "pub fnc main():int{val Rc<int> owner=Rc<int>(42);return 42;}",
    "pub fnc main():int{val Vector[int] values=[42];return 42;}",
    "pub fnc main():int{val Array<int> values=new Array<int>();return 42;}",
    "pub fnc main():int{val List<int> values=new List<int>();return 42;}",
    "pub fnc main():int{val SharedMutex<int> guard=SharedMutex<int>(42);return 42;}"
  ]) {
    assert.throws(() => rejectUnsupportedHeapContainerSource(utf8(source)),
      /wasm heap\/container ownership ABI unsupported/);
  }
});

test("unproven heap ownership operations must reject before LLVM compile", () => {
  for (const source of [
    "fnc main():int{let x=42;rt take x;return x;}",
    "fnc main():int{let x=42;rt borrow x;return 42;}",
    "fnc main():int{let x=42;rt mut borrow x;return 42;}",
    "fnc main():int{let x=42;rt mut share x;return 42;}",
    "fnc main():int{let x=42;rt /* benign */ mut /* still tokens */ share x;return 42;}"
  ]) {
    assert.throws(() => rejectUnsupportedHeapContainerSource(utf8(source)),
      /wasm heap loan\/transfer lowering unsupported/);
  }
});

test("safe scalar sources and words hidden in comments or strings are not falsely gated", () => {
  for (const source of [
    "pub fnc main():int{return 21+21;}",
    "fnc main():int{return 42;} // Box<int> rt mut share",
    "/* Box<int> /* Arc<Mutex<int>> */ rt borrow x */ fnc main():int{return 42;}",
    "fnc Box():int{return 42;} fnc main():int{return 42;}",
    "fnc main():int{let message=\"Vector[int] rt mut share\";return 42;}",
    "fnc main():int{let x=42;return rt copy x;}",
    "fnc main():int{let x=42;return rt share x;}"
  ]) assert.doesNotThrow(() => rejectUnsupportedHeapContainerSource(utf8(source)));
});

test("invalid UTF-8 cannot bypass fail-closed heap tokens", () => {
  assert.throws(() => rejectUnsupportedHeapContainerSource(
    Uint8Array.from([0xc0, 0xaf, 0x42])), /encoded data was not valid/i);
});


test("canonical ownership-bang aliases cannot bypass the Wasm heap-loan gate", () => {
  for(const expression of [
    "borrow!owner", "borrow! owner", "borrow!mut owner", "borrow! mut owner",
    "take!owner", "take! owner", "share!owner", "copy!owner",
    "mut borrow!owner", "mut borrow! owner",
    "rt /* comment */ borrow owner", "rt mut borrow owner"
  ]) {
    const source="fnc main():int{let owner=42;"+expression+";return 42;}";
    assert.throws(()=>rejectUnsupportedHeapContainerSource(utf8(source)),
      /wasm heap loan\/transfer lowering unsupported/,
      "unsupported loan alias accepted: "+expression);
  }
});

test("inequality and inert ownership text remain outside the Wasm loan gate", () => {
  for(const source of [
    "fnc main():bool{val int borrow=1;val int other=2;return borrow!eq other;}",
    "fnc main():bool{val int copy=1;val int other=2;return copy!eq other;}",
    "fnc main():int{val int copy=42;return rt copy copy;}",
    "fnc main():int{return 42;} // take!x borrow! mut x",
    "fnc main():int{return 42;} /* borrow!x /* take!x */ mut borrow!x */",
    "fnc main():int{val string note=\"take!x share!x borrow!x\";return 42;}",
    "fnc main():int{val int borrow_foo=42;return borrow_foo;}"
  ]) assert.doesNotThrow(()=>rejectUnsupportedHeapContainerSource(utf8(source)),source);
});
