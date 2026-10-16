# Cross-backend scalar source gate v1

The reference source semantics come from Oreslang Java. Identical bytes in this directory
must be mirrored wherever this suite is used. The first two positive programs match the
existing Java/LLVM v1 admission fixtures.

Run the Python 3 standard-library-only gate with an explicit compiler command; never
execute this manifest as a shell script or count negative compiler crashes as rejection.

- **stdout-i64**: Forge source-interpreter execution, exact decimal result.
- **admission**: .NET source + verified IR acceptance only. It is NOT guest execution.
- Unsupported actor, async and structural constructs must return exactly exit 1, empty
  stdout and a nonempty diagnostic. A signal, timeout, exit 2, missing tool or empty
  diagnostic fails the gate.
- Every report includes a SHA-256 over the manifest and byte-exact fixtures. Exact
  candidate commit provenance is provided by CI; standalone runs may omit --revision.
- Real native/AOT execution must be verified by independent release workflows.

`python3 contracts/scalar/v1/run.py --backend forge --mode stdout-i64 --command './build/oresforge run {source}'`
`python3 contracts/scalar/v1/run.py --backend net --mode admission --command './artifacts/compiler/win-x64/oresnet.exe check {source}'`
