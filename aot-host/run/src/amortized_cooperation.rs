//! Prepared Wasm compiler/runtime safepoint quantum, NOT guest enforcement.
/// Wasmtime's independent hard fuel trap remains mandatory. A guest compiler
/// must emit these ticks in trusted Wasm code for this cadence to apply.
#[derive(Debug, Default)]
pub struct AmortizedCooperation {
    completed: u64,
    window: u16,
}

impl AmortizedCooperation {
    pub const POLL_INTERVAL: u16 = 128;
    pub const FAIRNESS_LIMIT: u64 = 512;

    pub fn begin_dispatch(&mut self) {
        self.completed = 0;
        self.window = 0;
    }

    // The common path never invokes the host/scheduler or samples a clock.
    // A separate window keeps polling even after total u64 saturation.
    pub fn completed_backedge_needs_poll(&mut self) -> bool {
        self.completed = self.completed.saturating_add(1);
        self.window += 1;
        if self.window != Self::POLL_INTERVAL {
            return false;
        }
        self.window = 0;
        true
    }

    pub fn fairness_expired(&self) -> bool {
        self.completed >= Self::FAIRNESS_LIMIT
    }
}

#[cfg(test)]
mod tests {
    use super::AmortizedCooperation;

    #[test]
    fn polls_once_per_128_even_after_fairness_exhaustion() {
        let mut quantum = AmortizedCooperation::default();
        let mut polls = 0;
        for tick in 1..=1024 {
            let due = quantum.completed_backedge_needs_poll();
            assert_eq!(due, tick % 128 == 0, "poll at tick {tick}");
            assert_eq!(quantum.fairness_expired(), tick >= 512);
            if due { polls += 1; }
        }
        assert_eq!(polls, 8);
        quantum.begin_dispatch();
        for _ in 0..127 { assert!(!quantum.completed_backedge_needs_poll()); }
        assert!(quantum.completed_backedge_needs_poll());
    }
}
