//! Prepared host-side Wasm compiler/runtime quantum, NOT guest enforcement.
//! Wasmtime's independent per-Store hard fuel trap stays mandatory. Actual
//! guest code must be instrumented and verified by its trusted compiler.
#[derive(Debug)]
pub struct AmortizedCooperation {
    completed_batches: u64,
    remaining: u16,
}

impl Default for AmortizedCooperation {
    fn default() -> Self {
        Self { completed_batches: 0, remaining: Self::POLL_INTERVAL }
    }
}

impl AmortizedCooperation {
    pub const POLL_INTERVAL: u16 = 128;
    pub const FAIRNESS_LIMIT: u64 = 512;

    pub fn begin_dispatch(&mut self) {
        // Reset scheduling fairness only, NEVER separate hard tenant fuel.
        self.completed_batches = 0;
        self.remaining = Self::POLL_INTERVAL;
    }

    // One small decrement and branch per committed backedge. Aggregate u64
    // accounting happens only once per 128 ticks, including while overdue.
    pub fn completed_backedge_needs_poll(&mut self) -> bool {
        self.remaining -= 1;
        if self.remaining != 0 {
            return false;
        }
        self.remaining = Self::POLL_INTERVAL;
        self.completed_batches = self.completed_batches.saturating_add(
            u64::from(Self::POLL_INTERVAL));
        true
    }

    pub fn completed_backedges(&self) -> u64 {
        self.completed_batches.saturating_add(u64::from(
            Self::POLL_INTERVAL - self.remaining))
    }

    pub fn fairness_expired(&self) -> bool {
        self.completed_backedges() >= Self::FAIRNESS_LIMIT
    }
}

#[cfg(test)]
mod tests {
    use super::AmortizedCooperation;

    #[test]
    fn polls_only_once_per_128_even_after_fairness_exhaustion() {
        let mut quantum = AmortizedCooperation::default();
        let mut polls = 0;
        for tick in 1..=1_000_000 {
            let due = quantum.completed_backedge_needs_poll();
            assert_eq!(due, tick % 128 == 0, "unexpected poll at tick {tick}");
            assert_eq!(quantum.completed_backedges(), tick);
            assert_eq!(quantum.fairness_expired(), tick >= 512);
            if due { polls += 1; }
        }
        assert_eq!(polls, 7_812);
        assert_eq!(quantum.completed_backedges(), 1_000_000);
        quantum.begin_dispatch();
        assert_eq!(quantum.completed_backedges(), 0);
        for tick in 1..128 {
            assert!(!quantum.completed_backedge_needs_poll());
            assert_eq!(quantum.completed_backedges(), tick);
        }
        assert!(quantum.completed_backedge_needs_poll());
        assert_eq!(quantum.completed_backedges(), 128);
    }

    #[test]
    fn overflow_must_not_rearm_budget() {
        let mut q = AmortizedCooperation {
            completed_batches: u64::MAX,
            remaining: 1,
        };
        assert!(q.completed_backedge_needs_poll());
        assert_eq!(q.completed_backedges(), u64::MAX);
        for _ in 0..127 { assert!(!q.completed_backedge_needs_poll()); }
        assert!(q.completed_backedge_needs_poll());
        assert_eq!(q.completed_backedges(), u64::MAX);
        assert!(q.fairness_expired());
    }
}
