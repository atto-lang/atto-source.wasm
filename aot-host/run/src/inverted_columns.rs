//! Actor-local two-column SoA host oracle for future compiled inverted classes.
//!
//! NOT a guest ABI, compiler lowering, an actor scheduler, or proof of guest
//! execution. No imported host functions are added to the sealed Wasm profile.
//! The Rust side keeps two bounded scalar columns contiguous and validates
//! opaque owner + incarnation + arena identity + slot generation on every use.
//! Every operation after construction is free of dynamic allocation.

use std::sync::atomic::{compiler_fence, Ordering};
use std::sync::Arc;

const MAX_ROWS: usize = 256;
type Outcome<T> = Result<T, &'static str>;

#[derive(Clone)]
pub struct RowHandle {
    owner: u64,
    incarnation: u64,
    slot: usize,
    generation: u64,
    identity: Arc<()>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RowSnapshot {
    pub x: i64,
    pub y: i64,
    pub layout_epoch: u64,
}

/// Fixed-capacity, two-field scalar SoA: x[slot] and y[slot].
/// Boxed slices cannot silently grow when actor turns churn.
pub struct ActorLocalColumns {
    owner: u64,
    incarnation: u64,
    identity: Arc<()>,
    x: Box<[i64]>,
    y: Box<[i64]>,
    generations: Box<[u64]>,
    live: Box<[u8]>,
    used: usize,
    layout_epoch: u64,
    closed: bool,
}

impl ActorLocalColumns {
    pub fn new(owner: u64, incarnation: u64, capacity: usize) -> Outcome<Self> {
        if owner == 0 || incarnation == 0 || !(1..=MAX_ROWS).contains(&capacity) {
            return Err("invalid actor SoA owner, incarnation or capacity");
        }
        Ok(Self {
            owner,
            incarnation,
            identity: Arc::new(()),
            x: vec![0; capacity].into_boxed_slice(),
            y: vec![0; capacity].into_boxed_slice(),
            generations: vec![1; capacity].into_boxed_slice(),
            live: vec![0; capacity].into_boxed_slice(),
            used: 0,
            layout_epoch: 1,
            closed: false,
        })
    }

    pub fn capacity(&self) -> usize { self.x.len() }
    pub fn len(&self) -> usize { self.used }
    pub fn epoch(&self) -> u64 { self.layout_epoch }

    fn checked_slot(&self, handle: &RowHandle) -> Outcome<usize> {
        if self.closed { return Err("actor SoA is closed"); }
        if handle.owner != self.owner ||
            handle.incarnation != self.incarnation ||
            !Arc::ptr_eq(&handle.identity, &self.identity) {
            return Err("foreign actor SoA handle");
        }
        if handle.slot >= self.capacity() ||
            self.live[handle.slot] != 1 ||
            self.generations[handle.slot] != handle.generation {
            return Err("stale actor SoA row handle");
        }
        Ok(handle.slot)
    }

    pub fn insert(&mut self, x: i64, y: i64) -> Outcome<RowHandle> {
        if self.closed { return Err("actor SoA is closed"); }
        let next = self.layout_epoch.checked_add(1).ok_or("layout epoch exhausted")?;
        let slot = self.live.iter().position(|live| *live == 0)
            .ok_or("actor SoA capacity exhausted")?;
        self.x[slot] = x;
        self.y[slot] = y;
        self.live[slot] = 1;
        self.used += 1;
        self.layout_epoch = next;
        Ok(RowHandle {
            owner: self.owner,
            incarnation: self.incarnation,
            slot,
            generation: self.generations[slot],
            identity: Arc::clone(&self.identity),
        })
    }

    pub fn snapshot(&self, handle: &RowHandle) -> Outcome<RowSnapshot> {
        let slot = self.checked_slot(handle)?;
        Ok(RowSnapshot {
            x: self.x[slot],
            y: self.y[slot],
            layout_epoch: self.layout_epoch,
        })
    }

    /// Transactional checked numeric update: overflow on either column
    /// changes neither column nor layout epoch.
    pub fn move_by(&mut self, handle: &RowHandle, dx: i64, dy: i64) -> Outcome<()> {
        let slot = self.checked_slot(handle)?;
        let x = self.x[slot].checked_add(dx).ok_or("actor SoA x overflow")?;
        let y = self.y[slot].checked_add(dy).ok_or("actor SoA y overflow")?;
        let next = self.layout_epoch.checked_add(1).ok_or("layout epoch exhausted")?;
        self.x[slot] = x;
        self.y[slot] = y;
        self.layout_epoch = next;
        Ok(())
    }

    pub fn erase(&mut self, handle: &RowHandle) -> Outcome<()> {
        let slot = self.checked_slot(handle)?;
        let next_generation = self.generations[slot].checked_add(1)
            .ok_or("SoA row generation exhausted")?;
        let next_epoch = self.layout_epoch.checked_add(1)
            .ok_or("layout epoch exhausted")?;
        // Volatile writes prevent this explicit retirement scrub from being
        // optimized away as an ordinary dead store.
        unsafe {
            std::ptr::write_volatile(&mut self.x[slot], 0);
            std::ptr::write_volatile(&mut self.y[slot], 0);
        }
        compiler_fence(Ordering::SeqCst);
        self.generations[slot] = next_generation;
        self.live[slot] = 0;
        self.used -= 1;
        self.layout_epoch = next_epoch;
        Ok(())
    }

    fn scrub_columns(&mut self) {
        for value in self.x.iter_mut().chain(self.y.iter_mut()) {
            unsafe { std::ptr::write_volatile(value, 0); }
        }
        compiler_fence(Ordering::SeqCst);
        self.live.fill(0);
        self.used = 0;
    }

    pub fn close(&mut self) -> Outcome<()> {
        if self.closed { return Err("actor SoA already closed"); }
        self.scrub_columns();
        self.closed = true;
        Ok(())
    }
}

impl Drop for ActorLocalColumns {
    fn drop(&mut self) {
        if !self.closed {
            self.scrub_columns();
            self.closed = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocation_is_bounded_and_churn_reuses_slots_without_old_authority() {
        let mut rows = ActorLocalColumns::new(9, 1, 2).unwrap();
        let first = rows.insert(5, 8).unwrap();
        let another = rows.insert(11, 13).unwrap();
        assert!(rows.insert(99, 99).is_err());
        assert_eq!(rows.capacity(), 2);
        assert_eq!(rows.len(), 2);
        rows.erase(&first).unwrap();
        assert!(rows.snapshot(&first).is_err());
        let mut current = rows.insert(21, 34).unwrap();
        assert!(rows.snapshot(&first).is_err());
        assert_eq!(rows.snapshot(&current).unwrap().x, 21);
        assert_eq!(rows.snapshot(&another).unwrap().y, 13);
        for _ in 0..128 {
            let stale = current.clone();
            rows.erase(&current).unwrap();
            current = rows.insert(21, 34).unwrap();
            assert!(rows.snapshot(&stale).is_err());
            assert_eq!(rows.snapshot(&current).unwrap().y, 34);
            assert_eq!(rows.capacity(), 2);
            // Every successful operation here reuses a preallocated slot.
        }
    }

    #[test]
    fn owner_and_incarnation_are_insufficient_without_arena_identity() {
        let mut left = ActorLocalColumns::new(42, 7, 1).unwrap();
        let mut right = ActorLocalColumns::new(42, 7, 1).unwrap();
        let a = left.insert(1, 2).unwrap();
        right.insert(3, 4).unwrap();
        assert!(right.snapshot(&a).is_err(), "same actor labels do not grant authority");
        assert!(right.erase(&a).is_err());
        assert_eq!(right.len(), 1);
    }

    #[test]
    fn checked_move_is_atomic_and_snapshots_are_detached_values() {
        let mut rows = ActorLocalColumns::new(42, 3, 1).unwrap();
        let h = rows.insert(i64::MAX, -3).unwrap();
        let prior = rows.snapshot(&h).unwrap();
        assert!(rows.move_by(&h, 1, 5).is_err());
        assert_eq!(rows.snapshot(&h).unwrap(), prior);
        rows.move_by(&h, -1, 5).unwrap();
        assert_eq!(rows.snapshot(&h).unwrap().x, i64::MAX-1);
        assert_eq!(rows.snapshot(&h).unwrap().y, 2);
        assert_eq!(prior.y, -3, "prior scalar snapshot must not alias columns");
    }

    #[test]
    fn close_scrubs_both_columns_and_revokes_handles() {
        let mut rows = ActorLocalColumns::new(1, 1, 2).unwrap();
        let old = rows.insert(42, -17).unwrap();
        rows.close().unwrap();
        assert_eq!(&*rows.x, &[0, 0]);
        assert_eq!(&*rows.y, &[0, 0]);
        assert_eq!(rows.len(), 0);
        assert!(rows.snapshot(&old).is_err());
        assert!(rows.insert(1, 1).is_err());
        assert!(rows.close().is_err());
    }

    #[test]
    fn rejects_invalid_quota_and_actor_identity() {
        for capacity in [0, MAX_ROWS+1, usize::MAX] {
            assert!(ActorLocalColumns::new(1, 1, capacity).is_err());
        }
        assert!(ActorLocalColumns::new(0, 1, 1).is_err());
        assert!(ActorLocalColumns::new(1, 0, 1).is_err());
        assert!(ActorLocalColumns::new(1, 1, MAX_ROWS).is_ok());
    }
}
