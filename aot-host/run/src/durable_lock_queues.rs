//! Trusted host-only durable scheduling queues inside a Wasmtime tenant Store.
//! Not a guest ABI, persistent message log, distributed lease, or OS sandbox.
#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct ActorKey { id: u64, incarnation: u64 }
impl ActorKey {
    pub(crate) fn host_issued(id: u64, incarnation: u64) -> Result<Self, &'static str> {
        if id == 0 || incarnation == 0 { return Err("invalid actor identity"); }
        Ok(Self { id, incarnation })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Ticket {
    generation: u64, lock_id: u64, sequence: u64, operation_id: u64, actor: ActorKey,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) locks: usize, pub(crate) entries: usize,
    pub(crate) bytes: usize, pub(crate) running_actors: usize,
    pub(crate) accepting: bool,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    pub(crate) max_locks: usize, pub(crate) max_entries: usize,
    pub(crate) max_per_lock: usize, pub(crate) max_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self { Self {max_locks: 1024, max_entries: 8192,
        max_per_lock: 128, max_bytes: 16 * 1024 * 1024} }
}
#[derive(Clone)]
struct Entry { ticket: Ticket, bytes: usize, claimed: bool }
pub(crate) struct DurableLockQueues {
    generation: u64,
    limits: Limits,
    lanes: HashMap<u64, VecDeque<Entry>>,
    operations: HashSet<u64>,
    running: HashSet<ActorKey>,
    next_seq: u64,
    entries: usize,
    bytes: usize,
    accepting: bool,
}
impl DurableLockQueues {
    pub(crate) fn new(generation: u64, limits: Limits) -> Result<Self, &'static str> {
        if generation == 0 || limits.max_locks == 0 || limits.max_entries == 0 ||
           limits.max_per_lock == 0 || limits.max_bytes == 0 {
            return Err("invalid durable queue limits");
        }
        Ok(Self { generation, limits, lanes: HashMap::new(),
            operations: HashSet::new(), running: HashSet::new(),
            next_seq: 1, entries: 0, bytes: 0, accepting: true })
    }
    pub(crate) fn enqueue(&mut self, actor: ActorKey, lock_id: u64,
        operation_id: u64, bytes: usize) -> Result<(Ticket, bool), &'static str> {
        if lock_id == 0 || operation_id == 0 || bytes == 0 { return Err("invalid queue input"); }
        if !self.accepting { return Err("quiescing"); }
        if self.operations.contains(&operation_id) { return Err("duplicate pending operation"); }
        let existing = self.lanes.get(&lock_id);
        if self.entries >= self.limits.max_entries ||
           bytes > self.limits.max_bytes - self.bytes ||
           (existing.is_none() && self.lanes.len() >= self.limits.max_locks) ||
           existing.is_some_and(|lane| lane.len() >= self.limits.max_per_lock) {
            return Err("queue quota exceeded");
        }
        let next = self.next_seq.checked_add(1).ok_or("sequence exhausted")?;
        let ticket = Ticket {generation:self.generation,lock_id,
            sequence:self.next_seq,operation_id,actor};
        let lane = self.lanes.entry(lock_id).or_default();
        let head = lane.is_empty();
        lane.push_back(Entry {ticket, bytes, claimed:false});
        self.operations.insert(operation_id);
        self.next_seq = next;
        self.entries += 1;
        self.bytes += bytes;
        Ok((ticket,head))
    }
    fn head(&self, t: Ticket) -> Result<&Entry, &'static str> {
        if t.generation != self.generation { return Err("foreign ticket"); }
        let entry = self.lanes.get(&t.lock_id).and_then(|q|q.front())
            .ok_or("missing FIFO head")?;
        if entry.ticket != t { return Err("not FIFO head"); }
        Ok(entry)
    }
    pub(crate) fn claim(&mut self, t: Ticket) -> Result<bool, &'static str> {
        if !self.accepting { return Err("claims closed"); }
        if self.head(t)?.claimed { return Err("already claimed"); }
        if self.running.contains(&t.actor) { return Ok(false); }
        self.running.insert(t.actor);
        self.lanes.get_mut(&t.lock_id).ok_or("missing lane")?
            .front_mut().ok_or("missing head")?.claimed = true;
        Ok(true)
    }
    fn remove_head(&mut self, t: Ticket) -> Option<Ticket> {
        let lane = self.lanes.get_mut(&t.lock_id).expect("validated head");
        let popped = lane.pop_front().expect("validated entry");
        self.operations.remove(&popped.ticket.operation_id);
        self.entries -= 1;
        self.bytes -= popped.bytes;
        let next = lane.front().map(|entry|entry.ticket);
        if lane.is_empty() { self.lanes.remove(&t.lock_id); }
        next
    }
    pub(crate) fn finish(&mut self,t:Ticket)->Result<Option<Ticket>, &'static str>{
        if !self.head(t)?.claimed { return Err("unclaimed finish"); }
        if !self.running.remove(&t.actor) { return Err("not running"); }
        Ok(self.remove_head(t))
    }
    pub(crate) fn cancel_head(&mut self,t:Ticket)->Result<Option<Ticket>, &'static str>{
        if self.head(t)?.claimed { return Err("running head cannot cancel"); }
        Ok(self.remove_head(t))
    }
    pub(crate) fn cancel_waiter(&mut self,t:Ticket)->Result<(), &'static str>{
        if t.generation != self.generation { return Err("foreign ticket"); }
        let lane=self.lanes.get_mut(&t.lock_id).ok_or("unknown lane")?;
        let position=lane.iter().position(|entry|entry.ticket==t).ok_or("unknown ticket")?;
        if position==0 { return Err("head is not a waiter"); }
        let popped=lane.remove(position).ok_or("missing waiter")?;
        self.operations.remove(&popped.ticket.operation_id);
        self.entries-=1;
        self.bytes-=popped.bytes;
        Ok(())
    }
    pub(crate) fn has_actor(&self,actor:ActorKey)->bool {
        self.lanes.values().any(|lane|lane.iter().any(|entry|entry.ticket.actor==actor))
    }
    pub(crate) fn quiesce(&mut self) { self.accepting=false; }
    pub(crate) fn drained(&self)->bool {
        !self.accepting && self.entries==0 && self.running.is_empty()
    }
    pub(crate) fn snapshot(&self)->Snapshot {
        Snapshot {locks:self.lanes.len(),entries:self.entries,bytes:self.bytes,
            running_actors:self.running.len(),accepting:self.accepting}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn actor(id:u64)->ActorKey { ActorKey::host_issued(id,1).unwrap() }
    #[test]
    fn fifo_actor_nonreentrancy_and_tenant_fencing() {
        let mut a=DurableLockQueues::new(11, Limits::default()).unwrap();
        let mut b=DurableLockQueues::new(12, Limits::default()).unwrap();
        let (t1,h1)=a.enqueue(actor(1),7,1,2).unwrap();
        let (t2,h2)=a.enqueue(actor(1),7,2,2).unwrap();
        let (t3,h3)=a.enqueue(actor(1),9,3,2).unwrap();
        let (foreign,_)=b.enqueue(actor(1),7,1,2).unwrap();
        assert!(h1 && !h2 && h3);
        assert!(a.claim(foreign).is_err());
        assert!(a.claim(t2).is_err());
        assert!(a.finish(t1).is_err());
        assert_eq!(a.claim(t1),Ok(true));
        assert_eq!(a.claim(t3),Ok(false));
        assert_eq!(a.finish(t1),Ok(Some(t2)));
        assert_eq!(a.claim(t3),Ok(true));
        assert_eq!(a.claim(t2),Ok(false));
        assert_eq!(a.finish(t3),Ok(None));
        assert_eq!(a.claim(t2),Ok(true));
        assert_eq!(a.finish(t2),Ok(None));
        assert!(a.claim(t1).is_err());
    }
    #[test]
    fn quotas_cancellation_shutdown_and_separate_actors() {
        let mut q=DurableLockQueues::new(2,Limits{
            max_locks:2,max_entries:3,max_per_lock:2,max_bytes:6}).unwrap();
        let (a,_)=q.enqueue(actor(1),1,1,4).unwrap();
        assert!(q.enqueue(actor(1),2,2,4).is_err());
        let (b,_)=q.enqueue(actor(2),2,2,1).unwrap();
        assert_eq!(q.claim(a),Ok(true));
        assert_eq!(q.claim(b),Ok(true));
        assert!(q.cancel_head(a).is_err());
        assert_eq!(q.snapshot().running_actors,2);
        assert_eq!(q.finish(a),Ok(None)); assert_eq!(q.finish(b),Ok(None));
        let (x,_)=q.enqueue(actor(1),1,5,1).unwrap();
        let (y,_)=q.enqueue(actor(1),1,6,1).unwrap();
        q.cancel_waiter(y).unwrap();
        q.quiesce();
        assert!(q.claim(x).is_err());
        assert_eq!(q.cancel_head(x),Ok(None));
        assert!(q.drained());
    }
}
