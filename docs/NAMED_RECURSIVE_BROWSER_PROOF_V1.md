# Named recursive browser consumer proof (candidate)
 
This repository consumes the canonical Rust browser compiler; this is not a
new independent compiler implementation and does not refresh the vendored
compiler. No private-source export is authorized by this change.

Required delegated execution (not an optional/skipped npm test):

```sh
ATTO_BROWSER_SOURCE_ROOT=/authorized/local/rust-checkout \
ATTO_RECURSIVE_FIXTURE_ROOT=/authorized/local/conformance-checkout \
npm run test:named-recursive-browser
```

The script requires the exact commit and tree pins in its source, fresh local
Git checkout, installed Rust wasm32 target, and locked offline Cargo build.
No cross-organization credential or source upload is involved. The local
toolchain and its configuration are trusted inputs. Actual browser compiler
ABI v2 runs inside a time-bounded worker. The worker checks full i64 values,
three invocations per value, exact language panic codes, targeted scope
rejection and recovery. The exact naive Fibonacci(55) source is compile-only.
Nested linear-recursive fixtures remain explicitly unexecuted. The worker is
a test process control, not a hostile tenant sandbox or strict memory bound.

Local synthetic observer control test: Node v22.16.0, 5/5 passed, exact Git
blobs worker 0d68dac9a40f0d8e0509a3ee64ca83cdfe346aa9 and test
babb8c69a274afb5b37e6b494944104ca1821239. These validate the observer, not
the Atto compiler. Real delegated Rust compiler execution NOT_EXECUTED.
