// 1000 tenants in one OS process: one Engine, one Store + Instance per tenant, a fixed thread
// pool, epoch interruption for kills. Same hostile guest shape as the LLVM path.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use wasmtime::*;

const GUEST: &str = r#"(module
  (memory (export "memory") 1 256)
  (table 1 funcref)
  (type $unused (func (param i64) (result i64)))
  (global $counter (mut i64) (i64.const 0))
  (func $recurse (param $n i64) (result i64)
    (i64.add (call $recurse (i64.add (local.get $n) (i64.const 1))) (i64.const 1)))
  (func (export "add") (param i64) (result i64)
    (global.set $counter (i64.add (global.get $counter) (local.get 0)))
    (global.get $counter))
  (func (export "peek") (param i32) (result i64) (i64.load (local.get 0)))
  (func (export "peek_far") (param i32) (result i64) (i64.load offset=4294967295 (local.get 0)))
  (func (export "poke") (param i32 i64) (i64.store (local.get 0) (local.get 1)))
  (func (export "trap") unreachable)
  (func (export "spin") (loop $l (br $l)))
  (func (export "recurse") (result i64) (call $recurse (i64.const 0)))
  (func (export "indirect") (param i32) (result i64)
    (call_indirect (type $unused) (i64.const 0) (local.get 0)))
  (func (export "bomb") (result i32)
    (local $pages i32)
    (loop $l
      (if (i32.ne (memory.grow (i32.const 16)) (i32.const -1))
        (then (local.set $pages (i32.add (local.get $pages) (i32.const 16))) (br $l))))
    (local.get $pages))
)"#;

struct Tenant { store: Store<StoreLimits>, instance: Instance }

fn tenant(engine: &Engine, module: &Module, deadline_ticks: u64) -> Tenant {
    let limits = StoreLimitsBuilder::new().memory_size(1 << 24).instances(1).memories(1).tables(1).build();
    let mut store = Store::new(engine, limits);
    store.limiter(|l| l);
    store.set_epoch_deadline(deadline_ticks);
    store.epoch_deadline_trap();
    let instance = Instance::new(&mut store, module, &[]).expect("instantiate");
    Tenant { store, instance }
}

fn add(t: &mut Tenant, delta: i64) -> Result<i64> {
    let f = t.instance.get_typed_func::<i64, i64>(&mut t.store, "add")?;
    t.store.set_epoch_deadline(100);
    f.call(&mut t.store, delta)
}

fn main() -> Result<()> {
    let mut config = Config::new();
    config.epoch_interruption(true);
    config.max_wasm_stack(1 << 20);
    let engine = Engine::new(&config)?;
    let start = Instant::now();
    let module = Module::new(&engine, GUEST)?;
    println!("compile: {:?}", start.elapsed());

    let ticking = Arc::new(AtomicBool::new(true));
    let ticker = { let e = engine.clone(); let t = ticking.clone();
        std::thread::spawn(move || while t.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(2)); e.increment_epoch(); }) };

    // 1000 tenants share one Engine and compiled Module; each has private memory and globals.
    const N: usize = 1000;
    let start = Instant::now();
    let tenants: Vec<Tenant> = (0..N).map(|_| tenant(&engine, &module, 100)).collect();
    println!("{} stores+instances: {:?}", N, start.elapsed());

    // A fixed pool services all of them: a Store is Send, so any thread can run it, one at a time.
    let queue = Arc::new((Mutex::new(tenants.into_iter().enumerate().map(|(i, t)| (i, t, 0i64)).collect::<VecDeque<_>>()), Condvar::new()));
    let turns = Arc::new(AtomicU64::new(0));
    let start = Instant::now();
    const ROUNDS: i64 = 200;
    let mut pool = vec![];
    for _ in 0..8 {
        let (q, turns) = (queue.clone(), turns.clone());
        pool.push(std::thread::spawn(move || {
            let mut finished = vec![];
            loop {
                let job = q.0.lock().unwrap().pop_front();
                let Some((i, mut t, round)) = job else { break };
                let total = add(&mut t, i as i64 + 1).expect("turn");
                assert_eq!(total, (i as i64 + 1) * (round + 1), "tenant {} saw foreign state", i);
                turns.fetch_add(1, Ordering::Relaxed);
                if round + 1 < ROUNDS { q.0.lock().unwrap().push_back((i, t, round + 1)); } else { finished.push((i, t)); }
            }
            finished
        }));
    }
    let mut survivors: Vec<(usize, Tenant)> = pool.into_iter().flat_map(|h| h.join().unwrap()).collect();
    survivors.sort_by_key(|(i, _)| *i);
    let elapsed = start.elapsed();
    println!("{} turns across {} tenants on 8 threads: {:?} ({:.2} us/turn wall, {:.0} turns/s)",
        turns.load(Ordering::Relaxed), N, elapsed, elapsed.as_micros() as f64 / turns.load(Ordering::Relaxed) as f64,
        turns.load(Ordering::Relaxed) as f64 / elapsed.as_secs_f64());

    // Hostile guests: addresses it can name. Each reads own memory or traps.
    let secret = 0x5EC12E7i64;
    let (_, victim) = &mut survivors[0];
    let poke = victim.instance.get_typed_func::<(i32, i64), ()>(&mut victim.store, "poke")?;
    poke.call(&mut victim.store, (1024, secret))?;
    let host_secret = Box::new(0x0BADC0DE5EC12E7i64);
    let host_addr = &*host_secret as *const i64 as u64;
    let mut trapped = 0; let mut own = 0;
    for name in ["peek", "peek_far"] {
        for addr in [0u32, 1024, 65528, 65536, 0x7FFFFFFF, 0x80000000, 0xFFFFFFF8, 0xFFFFFFFF, host_addr as u32, (host_addr >> 32) as u32] {
            let mut t = tenant(&engine, &module, 100);
            let f = t.instance.get_typed_func::<i32, i64>(&mut t.store, name)?;
            match f.call(&mut t.store, addr as i32) {
                Ok(v) => { assert_ne!(v, secret, "read the victim"); assert_ne!(v, *host_secret, "read the host"); own += 1; }
                Err(e) => { assert_eq!(e.downcast_ref::<Trap>(), Some(&Trap::MemoryOutOfBounds)); trapped += 1; }
            }
        }
    }
    println!("20 hostile reads: {} in own memory, {} trapped", own, trapped);

    // Faults: each ends that Store only; a survivor keeps running on the same threads.
    let (_, stay) = &mut survivors[1];
    let mut expected = 2 * ROUNDS;
    for (name, want) in [("trap", Trap::UnreachableCodeReached), ("spin", Trap::Interrupt), ("recurse", Trap::StackOverflow)] {
        let mut t = tenant(&engine, &module, 100);
        let started = Instant::now();
        let err = if name == "recurse" {
            t.instance.get_typed_func::<(), i64>(&mut t.store, name)?.call(&mut t.store, ()).unwrap_err()
        } else {
            t.instance.get_typed_func::<(), ()>(&mut t.store, name)?.call(&mut t.store, ()).unwrap_err()
        };
        assert_eq!(err.downcast_ref::<Trap>(), Some(&want), "{}", name);
        println!("  {:<10} -> {:?} in {:?}", name, want, started.elapsed());
        expected += 2;
        assert_eq!(add(stay, 2)?, expected);
    }
    let mut t = tenant(&engine, &module, 100);
    let err = t.instance.get_typed_func::<i32, i64>(&mut t.store, "indirect")?.call(&mut t.store, 12345).unwrap_err();
    println!("  indirect   -> {:?}", err.downcast_ref::<Trap>());
    let mut t = tenant(&engine, &module, 100);
    let pages = t.instance.get_typed_func::<(), i32>(&mut t.store, "bomb")?.call(&mut t.store, ())?;
    println!("  memory bomb stopped by limit at {} extra pages ({} MiB)", pages, (pages + 1) as u64 * 64 / 1024);
    assert!((pages as u64 + 1) * 65536 <= 1 << 24);

    // Targeted kill. Epochs are per Engine, so advancing one reaches every Store at once. Each Store
    // gets a flag instead, and its epoch callback decides: only the flagged Store traps, without
    // anything touching it from outside. Six tenants spin, one is killed at a time.
    const SPINNERS: usize = 6;
    let flags: Vec<Arc<AtomicBool>> = (0..SPINNERS).map(|_| Arc::new(AtomicBool::new(false))).collect();
    let ended: Vec<Arc<AtomicBool>> = (0..SPINNERS).map(|_| Arc::new(AtomicBool::new(false))).collect();
    let mut handles = vec![];
    for i in 0..SPINNERS {
        let mut t = tenant(&engine, &module, 1);
        let flag = flags[i].clone();
        t.store.epoch_deadline_callback(move |_| {
            if flag.load(Ordering::Acquire) { Err(Trap::Interrupt.into()) } else { Ok(UpdateDeadline::Continue(1)) }
        });
        let spin = t.instance.get_typed_func::<(), ()>(&mut t.store, "spin")?;
        let done = ended[i].clone();
        handles.push(std::thread::spawn(move || {
            let result = spin.call(&mut t.store, ());
            done.store(true, Ordering::Release);
            result.unwrap_err()
        }));
    }
    std::thread::sleep(Duration::from_millis(50));
    assert!(ended.iter().all(|e| !e.load(Ordering::Acquire)), "a spinner ended by itself");
    let mut worst = Duration::ZERO;
    let mut handles: Vec<_> = handles.into_iter().map(Some).collect();
    for victim in 0..SPINNERS {
        let started = Instant::now();
        flags[victim].store(true, Ordering::Release);
        let error = handles[victim].take().unwrap().join().unwrap();
        worst = worst.max(started.elapsed());
        assert_eq!(error.downcast_ref::<Trap>(), Some(&Trap::Interrupt));
        // Give a wrong kill time to land. Everyone not yet flagged must still be running.
        std::thread::sleep(Duration::from_millis(10));
        for other in victim + 1..SPINNERS {
            assert!(!ended[other].load(Ordering::Acquire), "killing {} also ended {}", victim, other);
        }
    }
    println!("  targeted kill: {} spinning tenants ended one at a time, none early, worst {:?}", SPINNERS, worst);

    ticking.store(false, Ordering::Relaxed);
    ticker.join().unwrap();
    drop(survivors);
    println!("WASMTIME_SPIKE_PASS");
    Ok(())
}
