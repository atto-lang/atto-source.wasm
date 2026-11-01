"""Host-only continuation placement reference model. NOT native guest parity."""
from dataclasses import dataclass, replace
import random
import unittest

@dataclass(frozen=True)
class Worker:
    slot: int
    generation: int
    domain: str
    pending: int
    accepting: bool = True

@dataclass(frozen=True)
class Resume:
    domain: str
    actor_generation: int
    preferred_slot: int = -1
    preferred_generation: int = 0
    cancelled: bool = False
    expired: bool = False
    code_current: bool = True
    physical_active: bool = False

def choose(request, actor_generation, workers, slack=1):
    """Pure, bounded policy model: placement is not permission to execute."""
    if not request.domain or actor_generation < 1 or request.actor_generation < 1:
        raise ValueError("invalid actor")
    if not 0 <= slack <= 1024:
        raise ValueError("invalid slack")
    if any(w.slot < 0 or w.generation < 1 or not w.domain or w.pending < 0
           for w in workers) or len({w.slot for w in workers}) != len(workers):
        raise ValueError("invalid workers")
    if (request.cancelled or request.expired or not request.code_current
        or request.physical_active or request.actor_generation != actor_generation):
        return None
    eligible = [w for w in workers if w.accepting and w.domain == request.domain]
    if not eligible:
        return None
    lowest = min(w.pending for w in eligible)
    for w in eligible:
        if (w.slot == request.preferred_slot
            and w.generation == request.preferred_generation
            and w.pending <= lowest + slack):
            return w.slot
    return min((w.slot for w in eligible if w.pending == lowest))

class ContinuationLocalityTests(unittest.TestCase):
    def setUp(self):
        self.workers = (Worker(0, 4, "SHARED", 0),
                        Worker(1, 8, "SHARED", 0),
                        Worker(2, 3, "CONTROL", 0),
                        Worker(3, 2, "UNTRUSTED", 0))
        self.req = Resume("SHARED", 11, 0, 4)

    def run_choice(self, request=None, workers=None, generation=11, slack=1):
        return choose(self.req if request is None else request, generation,
                      self.workers if workers is None else workers, slack)

    def test_same_worker_preferred(self):
        self.assertEqual(0, self.run_choice())

    def test_small_queue_preserves_locality(self):
        self.assertEqual(0, self.run_choice(workers=(
            replace(self.workers[0], pending=1),) + self.workers[1:]))

    def test_backlog_causes_soft_spill(self):
        self.assertEqual(1, self.run_choice(workers=(
            replace(self.workers[0], pending=3),) + self.workers[1:]))

    def test_zero_slack_spills_immediately(self):
        self.assertEqual(1, self.run_choice(workers=(
            replace(self.workers[0], pending=1),) + self.workers[1:], slack=0))

    def test_stale_worker_hint_drops_only_preference(self):
        self.assertEqual(1, self.run_choice(replace(self.req, preferred_generation=3),
            workers=(replace(self.workers[0], pending=2),) + self.workers[1:]))

    def test_retired_worker_falls_back(self):
        self.assertEqual(1, self.run_choice(workers=(
            replace(self.workers[0], accepting=False),) + self.workers[1:]))

    def test_foreign_preferred_worker_never_selected(self):
        self.assertEqual(0, self.run_choice(
            replace(self.req, preferred_slot=2, preferred_generation=3)))

    def test_foreign_workers_only_returns_unavailable(self):
        self.assertIsNone(self.run_choice(workers=self.workers[2:]))

    def test_no_workers_never_runs_inline(self):
        self.assertIsNone(self.run_choice(workers=()))

    def test_cancelled_fenced(self):
        self.assertIsNone(self.run_choice(replace(self.req, cancelled=True)))

    def test_deadline_fenced(self):
        self.assertIsNone(self.run_choice(replace(self.req, expired=True)))

    def test_actor_generation_fenced(self):
        self.assertIsNone(self.run_choice(generation=12))

    def test_old_code_fenced(self):
        self.assertIsNone(self.run_choice(replace(self.req, code_current=False)))

    def test_double_physical_turn_fenced(self):
        self.assertIsNone(self.run_choice(replace(self.req, physical_active=True)))

    def test_control_domain_remains_separate(self):
        self.assertEqual(2, self.run_choice(Resume("CONTROL", 11, 0, 4)))

    def test_no_hint_falls_back_to_least_loaded(self):
        self.assertEqual(0, self.run_choice(replace(self.req, preferred_slot=-1)))

    def test_malformed_snapshot_fails_closed(self):
        for workers in ((Worker(-1, 1, "SHARED", 0),),
                        (Worker(0, 0, "SHARED", 0),),
                        (Worker(0, 1, "", 0),),
                        (Worker(0, 1, "SHARED", -1),),
                        (Worker(0, 1, "SHARED", 0), Worker(0, 2, "SHARED", 0))):
            with self.subTest(workers=workers), self.assertRaises(ValueError):
                self.run_choice(workers=workers)
        for slack in (-1, 1025):
            with self.assertRaises(ValueError):
                self.run_choice(slack=slack)

    def test_deterministic_fuzz(self):
        rng = random.Random(20261101)
        for _ in range(2000):
            workers = tuple(replace(w, pending=rng.randrange(12),
                                    accepting=bool(rng.randrange(2)))
                            for w in self.workers)
            req = replace(self.req, preferred_generation=(4 if rng.randrange(5) else 99))
            answer = self.run_choice(req, workers=workers)
            eligible = [w for w in workers if w.accepting and w.domain == "SHARED"]
            self.assertTrue(answer is None or answer in {w.slot for w in eligible})
            if answer is not None and workers[0].accepting and req.preferred_generation == 4:
                self.assertEqual(answer == 0, workers[0].pending <=
                                 min(w.pending for w in eligible) + 1)

if __name__ == "__main__":
    unittest.main()
