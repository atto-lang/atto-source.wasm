------------------- MODULE WasmActorRetirement -------------------
EXTENDS Naturals

\* A deliberately small CONTROL model. Each worker starts with one actor
\* lifetime pin; cancellation/deadlines do not free either. Only its
\* physical exit receipt releases that pin. Actor memory can be recycled
\* only after the last turn and all guest workers have quiesced.
\* Model-check with TLC and formal/WasmActorRetirement.cfg.
CONSTANT MaxStarts
ASSUME MaxStarts > 0

VARIABLES phase, turn, active, pins, started, cancelRequested
vars == <<phase, turn, active, pins, started, cancelRequested>>

Init ==
  /\ phase = "running"
  /\ turn = TRUE
  /\ active = 0
  /\ pins = 0
  /\ started = 0
  /\ cancelRequested = FALSE

BeginTurn ==
  /\ phase = "running"
  /\ ~turn
  /\ turn' = TRUE
  /\ UNCHANGED <<phase, active, pins, started, cancelRequested>>

EndTurn ==
  /\ turn
  /\ turn' = FALSE
  /\ UNCHANGED <<phase, active, pins, started, cancelRequested>>

StartWorker ==
  /\ phase = "running"
  /\ turn
  /\ started < MaxStarts
  /\ active < MaxStarts
  /\ active' = active + 1
  /\ pins' = pins + 1
  /\ started' = started + 1
  /\ UNCHANGED <<phase, turn, cancelRequested>>

StopAdmission ==
  /\ phase = "running"
  /\ phase' = "stopping"
  /\ UNCHANGED <<turn, active, pins, started, cancelRequested>>

CancelWorker ==
  /\ active > 0
  /\ ~cancelRequested
  /\ cancelRequested' = TRUE
  /\ UNCHANGED <<phase, turn, active, pins, started>>

WorkerExitReceipt ==
  /\ active > 0
  /\ pins > 0
  /\ active' = active - 1
  /\ pins' = pins - 1
  /\ UNCHANGED <<phase, turn, started, cancelRequested>>

Retire ==
  /\ phase = "stopping"
  /\ ~turn
  /\ pins = 0
  /\ active = 0
  /\ phase' = "retired"
  /\ UNCHANGED <<turn, active, pins, started, cancelRequested>>

Reuse ==
  /\ phase = "retired"
  /\ phase' = "reused"
  /\ UNCHANGED <<turn, active, pins, started, cancelRequested>>

Next ==
  \/ BeginTurn
  \/ EndTurn
  \/ StartWorker
  \/ StopAdmission
  \/ CancelWorker
  \/ WorkerExitReceipt
  \/ Retire
  \/ Reuse

Spec == Init /\ [][Next]_vars

PinsMatch == pins = active
SafeRetirement ==
  (phase = "retired" \/ phase = "reused")
    => (~turn /\ active = 0 /\ pins = 0)

=================================================================
