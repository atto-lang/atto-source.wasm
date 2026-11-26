// Source-only tests: execute a deliberately tiny checked scalar subset of the
// three Wasm .atto source files. NOT a native Atto compiler, guest, or AOT test.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const modules = {
  mem: {
    path: "../stdlib/core/mem.atto",
    names: ["is_power_of_two_alignment", "align_up_checked", "layout_stride",
      "array_bytes_checked", "span_fits"]
  },
  ptr: {
    path: "../stdlib/core/ptr.atto",
    names: ["checked_span_end", "checked_index_offset", "can_split_span"]
  },
  atomic: {
    path: "../stdlib/core/atomic.atto",
    names: ["default_order", "valid_load_order", "valid_store_order",
      "valid_rmw_order", "valid_fence_order", "valid_compare_exchange_orders"]
  }
};

const functions = {};
for (const [moduleName, module] of Object.entries(modules)) {
  const source = readFileSync(new URL(module.path, import.meta.url), "utf8");
  // Not an Atto grammar: only an auditable straight-line arithmetic subset.
  const stripped = source.replace(/\/\/[^\n]*/g, "");
  const pattern = /^pub fnc ([a-z_][a-z0-9_]*)\(([^)]*)\): (bool|int) \{([\s\S]*?)^\}/gm;
  const exports = [...stripped.matchAll(pattern)];
  assert.deepEqual(exports.map(x => x[1]), module.names, `unexpected ${moduleName} APIs`);
  assert.equal(stripped.replace(pattern, "").trim(), "", `unparsed ${moduleName} source`);
  const compiled = [];
  for (const entry of exports) {
    const name = entry[1];
    const formals = entry[2].split(",").filter(Boolean).map(param => {
      const match = /^int ([a-z_][a-z0-9_]*)$/.exec(param.trim());
      assert.ok(match, `unknown ${name} formal: ${param}`);
      return match[1];
    });
    let body = entry[4].replace(/if ([^\n;]+) then return ([^\n;]+); fi/g,
      "if ($1) return $2;");
    body = body.replace(/val int ([a-z_][a-z0-9_]*) =/g, "const $1 =");
    assert.doesNotMatch(body, /\b(?:fi|then|new|import|rt|await|throw|while|for|fnc|class)\b/,
      `unsupported statement in ${name}`);
    const remainder = body
      .replace(/\b(?:if|return|const|true|false)\b/g, "")
      .replace(/[a-z_][a-z0-9_]*/g, "")
      .replace(/[0-9]+/g, "")
      .replace(/[+*\/%<>=!&|;()\-\s]/g, "");
    assert.equal(remainder, "", `unexpected character in ${name} source`);
    body = body.replace(/(?<![a-zA-Z0-9_])([0-9]+)(?![a-zA-Z0-9_])/g, "$1n");
    compiled.push(`function ${name}(${formals.join(",")}) { ${body} }`);
  }
  const names = exports.map(x => x[1]);
  const impl = runInNewContext(
    `${compiled.join("\n")}\n({${names.join(",")}})`,
    Object.create(null),
    { timeout: 1000 }
  );
  Object.assign(functions, impl);
}

const vectors = [
  ["is_power_of_two_alignment", [0], false],
  ["is_power_of_two_alignment", [1], true],
  ["is_power_of_two_alignment", [8], true],
  ["is_power_of_two_alignment", [3], false],
  ["is_power_of_two_alignment", ["4611686018427387904"], true],
  ["align_up_checked", [0, 8], 0],
  ["align_up_checked", [7, 8], 8],
  ["align_up_checked", [16, 16], 16],
  ["align_up_checked", [-1, 8], -1],
  ["align_up_checked", [7, 3], -1],
  ["align_up_checked", ["9223372036854775807", 2], -1],
  ["align_up_checked", ["9223372036854775806", 2], "9223372036854775806"],
  ["layout_stride", [9, 8], 16],
  ["layout_stride", [0, 8], 0],
  ["layout_stride", ["9223372036854775807", 8], -1],
  ["array_bytes_checked", [4, 8, 32], 32],
  ["array_bytes_checked", [5, 8, 32], -1],
  ["array_bytes_checked", ["9223372036854775807", 2, "9223372036854775807"], -1],
  ["array_bytes_checked", [0, 8, 0], 0],
  ["array_bytes_checked", [4, 0, 0], 0],
  ["array_bytes_checked", [-1, 8, 32], -1],
  ["span_fits", [10, 0, 10], true],
  ["span_fits", [10, 10, 0], true],
  ["span_fits", [10, 10, 1], false],
  ["span_fits", [10, "9223372036854775807", 1], false],
  ["checked_span_end", [10, 4, 6], 10],
  ["checked_span_end", [10, 4, 7], -1],
  ["checked_span_end", ["9223372036854775807", "9223372036854775807", 0], "9223372036854775807"],
  ["checked_span_end", [-1, 0, 0], -1],
  ["checked_index_offset", [64, 0, 8, 7, 8, 8, 8], 56],
  ["checked_index_offset", [64, 0, 8, 8, 8, 8, 8], -1],
  ["checked_index_offset", [64, 8, 4, 3, 8, 8, 8], 32],
  ["checked_index_offset", [64, 1, 4, 0, 8, 8, 8], -1],
  ["checked_index_offset", [64, 0, 4, 0, 6, 8, 4], -1],
  ["checked_index_offset", [64, 0, 4, 0, 8, 0, 8], -1],
  ["checked_index_offset", [64, 0, 4, 3, 32, 8, 8], -1],
  ["checked_index_offset", [0, 0, 1, 0, 1, 1, 1], -1],
  ["can_split_span", [10, 4, 6, 6], true],
  ["can_split_span", [10, 4, 6, 7], false],
  ["can_split_span", [10, 6, 6, 0], false],
  ["default_order", [], 4],
  ["valid_load_order", [0], true],
  ["valid_load_order", [1], true],
  ["valid_load_order", [4], true],
  ["valid_load_order", [2], false],
  ["valid_load_order", [3], false],
  ["valid_store_order", [2], true],
  ["valid_store_order", [4], true],
  ["valid_store_order", [1], false],
  ["valid_rmw_order", [3], true],
  ["valid_rmw_order", [5], false],
  ["valid_fence_order", [0], false],
  ["valid_fence_order", [4], true],
  ["valid_compare_exchange_orders", [0, 0], true],
  ["valid_compare_exchange_orders", [0, 1], false],
  ["valid_compare_exchange_orders", [1, 1], true],
  ["valid_compare_exchange_orders", [2, 1], false],
  ["valid_compare_exchange_orders", [3, 1], true],
  ["valid_compare_exchange_orders", [4, 4], true],
  ["valid_compare_exchange_orders", [4, 2], false],
  ["valid_compare_exchange_orders", [4, 3], false],
  ["valid_compare_exchange_orders", [5, 0], false],
  ["valid_compare_exchange_orders", [1, 4], false]
];

test("source-only verification scope remains explicit", () => {
  assert.equal(Object.keys(functions).length, 14);
});
for (const [index, [name, args, expected]] of vectors.entries()) {
  test(`Atto source subset ${index + 1}: ${name}`, () => {
    assert.ok(Object.hasOwn(functions, name));
    const actual = functions[name](...args.map(x => BigInt(x)));
    assert.equal(actual, typeof expected === "boolean" ? expected : BigInt(expected));
  });
}
