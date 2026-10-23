-------------------- MODULE WasmGuestExposure --------------------
EXTENDS Naturals

\* A bounded abstraction of direct guest binding and irreversible exposure.
\* A native Wasm instance may retain its imported memory after detach.
VARIABLES phase, exposed, pins
vars == <<phase, exposed, pins>>

Init ==
  /\ phase = "live"
  /\ exposed = FALSE
  /\ pins = 0

Attach ==
  /\ phase = "live"
  /\ pins = 0
  /\ phase' = "live"
  /\ exposed' = TRUE
  /\ pins' = 1

Detach ==
  /\ phase = "live"
  /\ pins = 1
  /\ pins' = 0
  /\ UNCHANGED <<phase, exposed>>

Stop ==
  /\ phase = "live"
  /\ phase' = "stopping"
  /\ UNCHANGED <<exposed, pins>>

Drain ==
  /\ phase = "stopping"
  /\ pins = 1
  /\ pins' = 0
  /\ UNCHANGED <<phase, exposed>>

Retire ==
  /\ phase = "stopping"
  /\ pins = 0
  /\ phase' = "retired"
  /\ UNCHANGED <<exposed, pins>>

Reuse ==
  /\ phase = "retired"
  /\ ~exposed
  /\ phase' = "reused"
  /\ UNCHANGED <<exposed, pins>>

Quarantine ==
  /\ phase = "retired"
  /\ exposed
  /\ phase' = "quarantined"
  /\ UNCHANGED <<exposed, pins>>

Next == Attach \/ Detach \/ Stop \/ Drain \/ Retire \/ Reuse \/ Quarantine
Spec == Init /\ [][Next]_vars

InvariantNoReusedExposure == (phase = "reused") => ~exposed
InvariantNoRetiredPins ==
  (phase = "retired" \/ phase = "reused" \/ phase = "quarantined")
    => pins = 0
InvariantQuarantine == (phase = "quarantined") => exposed
===============================================================
