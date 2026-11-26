# Shared stdlib guest evidence adapter hardening

The existing 127 stdout reference lines and three guest blobs are unchanged.
The adapter now independently pins the manifest Git blob and fixture blobs,
rejects linked inputs, bounds reads, rechecks runner identity and all input
bytes before and after each child, uses a minimal child environment and
strict UTF-8/output comparison without trimming arbitrary whitespace.
Synthetic tests cover 12 positive/negative scenarios. A matching stdout
receipt is only candidate evidence; a synthetic runner can print it.
Trusted clean parent, isolated checkout, independently authenticated
compiler/transitive toolchain, exact full-tree verification and actual
compiler/artifact provenance remain mandatory. Linux host only; process
timeout does not sandbox detached descendants. No actual guest proof.
