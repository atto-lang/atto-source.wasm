import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileOresToWasm, readBoundedRegularFile} from "../scripts/compile-ores.mjs";

// This test only counts as parity if the REAL pinned LLVM compiler produces
// wasm32 code and the actual WebAssembly guest returns 42. No fake compiler,
// parser-only check, static claim, or skipped test can promote this feature.
const SOURCES = Object.freeze({
  "arrow-double-colon": `pub define class Connection as
  pub int answer;
  initialize(int id) -> void ::
    self.answer = id;
  end
end
pub fnc main(): int { let Connection c = new Connection(42); return c.answer; }
`,
  "arrow-newline": `pub define class Connection as
  pub val int answer;
  initialize(int id) -> void
    self.answer = id;
  end
end
pub fnc main(): int { let Connection c = new Connection(42); return c.answer; }
`,
  "colon-newline": `pub define class Connection as
  pub final int answer;
  initialize(int id): void
    self.answer = id;
  end
end
pub fnc main(): int { let Connection c = new Connection(42); return c.answer; }
`,
  "colon-braced": `pub define class Connection as
  pub int answer;
  initialize(int id): void {
    self.answer = id;
  }
end
pub fnc main(): int { let Connection c = new Connection(42); return c.answer; }
`,
});

test("real wasm32 guests execute all four typed initialize body forms", {
  skip: !process.env.ORESLANG_LLVM_COMPILER &&
    process.env.ORESLANG_REQUIRE_REAL_COMPILER === undefined,
  timeout: 180000
}, async () => {
  const compiler = process.env.ORESLANG_LLVM_COMPILER;
  assert.ok(compiler, "required real guest compiler is unavailable: cannot promote parity");
  assert.match(process.env.ORESLANG_LLVM_COMPILER_SHA256 || "", /^[a-f0-9]{64}$/,
    "missing exact compiler binary SHA-256");
  assert.match(process.env.ORESLANG_LLVM_SOURCE_SHA || "", /^[a-f0-9]{40}$/,
    "missing exact LLVM compiler source commit");
  const expected = process.env.ORESLANG_LLVM_COMPILER_SHA256;
  const binary = (await readBoundedRegularFile(compiler, 256 * 1024 * 1024)).bytes;
  assert.equal(createHash("sha256").update(binary).digest("hex"), expected,
    "actual native compiler does not match the supplied binary pin");
  const workspace = await mkdtemp(join(tmpdir(), "ores-wasm-typed-initialize-"));
  try {
    for (const [name, text] of Object.entries(SOURCES)) {
      const source = join(workspace, `${name}.ores`);
      const output = join(workspace, `${name}.wasm`);
      await writeFile(source, text, {flag: "wx"});
      const receipt = await compileOresToWasm({
        source, output, compiler, compilerSha256: expected, environment: "browser"
      });
      assert.equal(receipt.sourceSha256,
        createHash("sha256").update(Buffer.from(text)).digest("hex"),
        `${name}: unexpected input source provenance`);
      const guestBytes = await readFile(output);
      const guest = new WebAssembly.Instance(new WebAssembly.Module(guestBytes));
      assert.equal(typeof guest.exports.main, "function",
        `${name}: missing genuine wasm32 guest main`);
      assert.equal(guest.exports.main(), 42n,
        `${name}: real Wasm guest returned the wrong value`);
    }
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
});
