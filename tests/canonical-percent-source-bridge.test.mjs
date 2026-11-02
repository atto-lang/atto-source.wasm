import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {rejectLegacyPercentSource,compileOresToWasm} from "../scripts/compile-ores.mjs";

const bytes = text => Buffer.from(text, "utf8");

test("retired percent operator is refused in all expression positions", () => {
  for (const source of [
    "fnc main():int{return 7%3;}",
    "fnc main():int{return -7%-3;}",
    "fnc main():int{return (8%3)*2;}",
    "fnc main():int{return Integer.rem(7%3,2);}",
    "fnc main():int{return 1;} % ignored",
    "fnc main():int{return 2%0;}",
    "fnc main():int{return -9223372036854775808%-1;}",
    "fnc main():int{return 9;}// comment\r 7%3",
  ]) {
    assert.throws(() => rejectLegacyPercentSource(bytes(source)), /E_OPERATOR_REMOVED/);
  }
});

test("comment and quoted literal percent signs do not masquerade as operators", () => {
  for (const source of [
    "fnc main():int{return 42;} // % comment",
    "fnc main():int{return 42;} // % comment\r\n",
    "/* % nested /* % */ % */ fnc main():int{return 42;}",
    'fnc main():int{return 42;} // "%" and 7%3 are comment text',
    'fnc main():int{return 42;} "%" ',
    "fnc main():int{return 42;} '%' ",
    'fnc main():int{return 42;} "\\\"%\\\""',
  ]) {
    assert.doesNotThrow(() => rejectLegacyPercentSource(bytes(source)), source);
  }
});

test("non-ASCII source prefix cannot corrupt compiler-facing byte offsets", () => {
  for (const prefix of ["// café\n", "// 😀\n", "/* 東京 */\n"]) {
    const source=prefix+"fnc main():int{return 7 % 3;}";
    const offset=Buffer.byteLength(source.slice(0,source.indexOf("%")),"utf8");
    assert.throws(
      () => rejectLegacyPercentSource(bytes(source)),
      error => error.message.includes("E_OPERATOR_REMOVED") &&
               error.message.endsWith("at byte "+offset),
      source
    );
  }
});

test("fixed-seed Unicode/comment/literal prefixes preserve exact forbidden-operator byte offsets", () => {
  let seed=20261102;
  const next=() => {
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    return seed;
  };
  const prefix=[
    "// café\\n", "// 😀\\n", "/* 東京 */", "\\r", " ", "",
    "/* % */", '"%"', "// ignored\\r",
  ];
  for(let i=0;i<512;i++) {
    const pre=Array.from({length:1+next()%7},()=>prefix[next()%prefix.length]).join("");
    const source=pre+"7 % 3";
    const expected=Buffer.byteLength(pre+"7 ","utf8");
    assert.throws(
      () => rejectLegacyPercentSource(bytes(source)),
      error => error.message.includes("E_OPERATOR_REMOVED") &&
               error.message.endsWith("at byte "+expected),
      "case "+i
    );
  }
});

test("malformed quoted literals cannot hide lexical source admission", () => {
  for (const source of [
    'fnc main():int{return 42;} "unterminated %',
    "fnc main():int{return 42;} 'unterminated %",
  ]) {
    assert.throws(() => rejectLegacyPercentSource(bytes(source)), /unterminated quoted literal/);
  }
  assert.throws(() => rejectLegacyPercentSource(Buffer.from([0xff])), /encoded|UTF-8|valid/i);
});

test("malformed comments and literals have UTF-8 byte-aligned diagnostics", () => {
  for (const [prefix, ending, diagnostic] of [
    ["// café\\n", "/* never closed", "unterminated block comment"],
    ["// 😀\\n", '"never closed', "unterminated quoted literal"],
    ["/* 東京 */\\n", "'never closed", "unterminated quoted literal"],
  ]) {
    const source=prefix+ending;
    const offset=Buffer.byteLength(prefix, "utf8");
    assert.throws(
      () => rejectLegacyPercentSource(bytes(source)),
      error => error.message.includes(diagnostic) &&
               error.message.endsWith("at byte "+offset),
      source
    );
  }
});

test("negative legacy operator gate publishes no artifacts and invokes no native compiler", async () => {
  const dir=await mkdtemp(join(tmpdir(),"ores-wasm-no-percent-"));
  const source=join(dir,"source.ores"),compiler=join(dir,"unused-compiler"),output=join(dir,"result.wasm");
  try {
    await writeFile(source, "pub fnc main(): int { return 7 % 3; }");
    // This binary exists only to prove preflight precedes compiler execution.
    // It is not a real Oreslang compiler or positive guest test.
    await writeFile(compiler, "#!/bin/sh\nexit 71\n",{mode:0o700});
    await assert.rejects(
      compileOresToWasm({compiler,source,output,publication:"atomic"}),
      /E_OPERATOR_REMOVED/
    );
    for (const path of [output,output+".current.json",output+".provenance.json",output+".artifact.json",output+".releases"]) {
      await assert.rejects(stat(path), error => error?.code==="ENOENT");
    }
  } finally {
    await rm(dir,{recursive:true,force:true});
  }
});
