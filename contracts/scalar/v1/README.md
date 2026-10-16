# Cross-backend scalar source gate v1

The reference source semantics come from Oreslang Java. Identical bytes in this directory
must be mirrored wherever this suite is used. The first two positive programs match the
existing Java/LLVM v1 admission fixtures.

The 11-case revision has six positive signed-i64 programs and five negative
bootstrap-admission programs. The sixth positive fixture,
`fixtures/i64-max-minus-one.ores`, pins Java/LLVM reference arithmetic
`9223372036854775807 - 1 = 9223372036854775806` without overflowing
any i64 intermediate. This is a fixture contract, not proof that every
backend has executed or compiled it.

Run the Python 3 standard-library-only gate with an explicit compiler command; never
execute this manifest as a shell script or count negative compiler crashes as rejection.

- **stdout-i64**: Forge source-interpreter execution, exact decimal result.
- **admission**: .NET source + verified IR acceptance only. It is NOT guest execution.
- Unsupported actor, async and structural constructs must return exactly exit 1, empty
  stdout and a nonempty diagnostic. A signal, timeout, exit 2, missing tool or empty
  diagnostic fails the gate.
- Every report includes a SHA-256 over the manifest and byte-exact fixtures. Exact
  candidate commit provenance is provided by CI; standalone runs without a report may omit --revision.
  For a written --report, --revision is mandatory; the value is a declaration, not proof of the compiler's provenance.
- Real native/AOT execution must be verified by independent release workflows.

`python3 contracts/scalar/v1/run.py --backend forge --mode stdout-i64 --command './build/oresforge run {source}'`
`python3 contracts/scalar/v1/run.py --backend net --mode admission --command './artifacts/compiler/win-x64/oresnet.exe check {source}'`

## WebAssembly interpretation

`npm test` verifies the shared manifest, exact source inventory and digest without
claiming guest execution. The separately authorized `npm run test:real-compiler`
gate compiles and runs **only the six positive scalar programs** with the
hash-pinned LLVM compiler in the zero-import core Wasm host. The five
negative cases are expected *rejections by the .NET and Forge bootstrap
compilers*; a more complete LLVM compiler may implement those constructs.
Never report them as universal LLVM/WASM frontend rejection requirements.
