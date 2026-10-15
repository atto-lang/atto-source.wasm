# Mandatory nonblocking guest I/O

The runtime always declares `coreIoPolicy: native-async-only`. Public admission,
isolated execution and compiler bridge APIs reject unknown options, accessors,
proxies and policy overrides before acting on them. There is no option to grant
WASI, host imports or blocking workers. The parent verifies the worker's policy
metadata before accepting a result.

The scalar profile denies **all** imports before Wasm compilation. Tests use
valid Wasm modules importing fd_read, fd_write, path_open, sock_accept, HTTP,
TCP, stdio, poll and falsely async worker functions; admission and execution
reject each. Isolated workers meter/isolate CPU guest execution; they are not
blocking I/O implementations. The Wasmtime AOT profile also denies imports and
has no WASI linker. Its independent artifact trust and release gates remain.

The shared 22-case source corpus is executed through the real LLVM-to-Wasm
bridge when ORESLANG_LLVM_COMPILER is configured. Pure cases compile and execute;
unsupported I/O rejects without replacing a previously valid Wasm artifact.
Without the real compiler this integration is explicitly skipped, never claimed
as verified. Genuine guest async I/O and continuation/buffer ownership lowering
are still absent, so no FS/network/HTTP/stdio capability is advertised.

Trusted compiler/artifact loading and CLI diagnostics are host tooling and
must never be re-exported as guest fallbacks.
