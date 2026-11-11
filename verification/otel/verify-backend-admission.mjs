// Source-free OTel feature-admission gate. This does NOT execute any compiler.
// A passing result is only a checked blocker/evidence inventory.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROFILES = Object.freeze({
  'oreslang-source.java': ['java', ['java-graalvm-jit', 'java-graalvm-native-aot'], 'STDLIB_GUEST_CANDIDATE_UNVERIFIED'],
  'oreslang-source.llvm': ['llvm', ['llvm-native'], 'PARTIAL_NATIVE_STRING_CONSOLE_UNVERIFIED'],
  'oreslang-source.wasm': ['wasm', ['wasm-node-worker'], 'NO_GUEST_STDOUT_ABI'],
  'oreslang-source.forge': ['forge', ['forge-native'], 'SCALAR_BOOTSTRAP_NO_GUEST_OTEL'],
  'oreslang-source.net': ['net', ['net-native-aot'], 'SCALAR_NATIVE_AOT_NO_GUEST_OTEL'],
});
const REQUIRED = [
  'real_compiler_source_head_sha',
  'real_compiler_executable_sha256',
  'source_owned_guest_source_blobs',
  'guest_artifact_sha256',
  'actual_guest_stdout_sha256',
  'guest_process_success',
  'native_semantic_oracle_pass',
  'independent_original_head_CI_job_steps',
  'authenticated_exporter_storage_readback',
];
const ALLOWED_FIELDS = [
  'schema', 'repository', 'backend', 'profiles', 'canonical_contract',
  'fixture_git_blob', 'library_git_blob', 'current_status', 'blocking_capabilities',
  'required_evidence', 'runtime_parity_certified', 'otlp_wire_compatible_certified',
  'source_free_tests_are_guest_proof',
];
function check(condition, reason) {
  if (!condition) throw new Error('OTEL_BACKEND_NOT_ADMITTED: ' + reason);
}
export function validate(document, expectedRepository) {
  check(document && typeof document === 'object' && !Array.isArray(document),
    'manifest must be a JSON object');
  check(Object.keys(document).length === ALLOWED_FIELDS.length &&
    ALLOWED_FIELDS.every(key => Object.hasOwn(document, key)),
    'manifest has missing/extra keys');
  check(document.schema === 'oreslang-otel-backend-admission/v1', 'wrong contract schema');
  const suffix = document.repository?.replace('ores-truffle-oreslang/', '');
  check(typeof suffix === 'string' && Object.hasOwn(PROFILES, suffix) &&
    document.repository === 'ores-truffle-oreslang/' + suffix,
    'unexpected repository');
  check(expectedRepository === undefined || expectedRepository === document.repository,
    'source repo differs from GitHub job identity');
  const [backend, profiles, status] = PROFILES[suffix];
  check(document.backend === backend, 'backend name mismatch');
  check(JSON.stringify(document.profiles) === JSON.stringify(profiles), 'target profiles changed');
  check(document.current_status === status, 'unverified runtime promoted without guest evidence');
  check(document.canonical_contract ===
    'ores-truffle-oreslang/oreslang-platform-conformance:contracts/otel-five-backend-v1.json',
    'not the canonical OTel guest contract');
  check(document.fixture_git_blob === 'c22a8841b868cd89dd4cb720435d9585fbbb05cc' &&
    document.library_git_blob === '6a1b9b940f10e4b273ae2b02be5cfff5e0572afc',
    'stale/unknown telemetry source blobs');
  check(Array.isArray(document.blocking_capabilities) &&
    document.blocking_capabilities.length >= 2 &&
    document.blocking_capabilities.length <= 8 &&
    document.blocking_capabilities.every(v => typeof v === 'string' && v.length >= 25 && v.length <= 500),
    'unverified capability blockers must remain explicit');
  check(JSON.stringify(document.required_evidence) === JSON.stringify(REQUIRED),
    'mandatory compiler-to-exporter evidence omitted');
  for (const name of ['runtime_parity_certified',
    'otlp_wire_compatible_certified', 'source_free_tests_are_guest_proof']) {
    check(document[name] === false, 'host-only inventory falsely marked as parity');
  }
  return { backend, profiles, classification: 'SOURCE_ONLY_CANDIDATE',
    runtimeVerified: false, otlpVerified: false };
}

function run() {
  const manifest = JSON.parse(readFileSync(resolve('verification/otel/backend-admission-v1.json'), 'utf8'));
  const result = validate(manifest, process.env.GITHUB_REPOSITORY || undefined);
  if (process.argv.includes('--self-test')) {
    const changes = [
      o => { o.runtime_parity_certified = true; },
      o => { o.otlp_wire_compatible_certified = true; },
      o => { o.source_free_tests_are_guest_proof = true; },
      o => { o.backend = 'wasm'; },
      o => { o.profiles = ['invented-profile']; },
      o => { o.current_status = 'EXECUTED_GUEST'; },
      o => { o.fixture_git_blob = 'a'.repeat(40); },
      o => { o.required_evidence.pop(); },
      o => { o.blocking_capabilities = []; },
      o => { o.parity_gained_from_mock = true; },
      o => { o.repository = 'unreviewed/oesource'; },
    ];
    for (const change of changes) {
      const mutated = structuredClone(manifest);
      change(mutated);
      let denied = false;
      try { validate(mutated); } catch { denied = true; }
      check(denied, 'negative control unexpectedly accepted');
    }
    console.log('11 negative source-only capability promotions denied');
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (process.argv.includes('--require-executed-guest')) {
    throw new Error('OTEL_BACKEND_NOT_ADMITTED: this host-only check cannot certify guest execution');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(); } catch (err) {
    process.stderr.write(String(err.message).slice(0, 300) + '\n');
    process.exitCode = 1;
  }
}
