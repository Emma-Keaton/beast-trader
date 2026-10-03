/**
 * Cache with three behaviours that a market poller genuinely needs, and which
 * were conspicuously absent from every repo reviewed:
 *
 *  1. **Single-flight.** N concurrent callers asking for the same cold key
 *     produce exactly ONE network request. Without this, a dashboard open on
 *     three panels fires three identical calls.
 *  2. **Stale-while-revalidate.** When data is slightly past its TTL it is
 *     served instantly and refreshed in the background. A 30s poll interval
 *     then never blocks a user request waiting on a slow upstream.
 *  3. **Bounded LRU.** A map that only grows is a memory leak on a free-tier
 *     instance; eviction is by least-recently-used, as in
 *     `quantdinger/.../cache_manager.py:71-127` (their `move_to_end` is a
 *     `delete`+`set` in JS, since `Map` preserves insertion order).
 */

export class TtlCache {
  constructor({ max = 500, staleMs = 0, name = "cache" } = {}) {
    this.max = max;
    this.staleMs = staleMs; // how long past TTL a value may still be served
    this.name = name;
    this.map = new Map();
    this.pending = new Map(); // key -> in-flight promise (single-flight)
    this.hits = 0;
    this.misses = 0;
  }

  /** Fresh value, or undefined when absent or expired. */
  peek(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) return undefined;
    this.touch(key, e);
    return e.value;
  }

  /**
   * Get a value, calling `producer` on a miss.
   * Concurrent misses share one producer call.
   *
   * Named `fetch` rather than `get` on purpose: a `store.get(path, handler)`
   * call reads exactly like Express route registration to static analysis,
   * and this store is not a router.
   */
  async fetch(key, producer, ttlMs) {
    const fresh = this.peek(key);
    if (fresh !== undefined) {
      this.hits++;
      return fresh;
    }
    this.misses++;

    // Stale-while-revalidate: answer now, refresh behind the scenes.
    const stale = this.map.get(key);
    if (stale && Date.now() <= stale.expiresAt + this.staleMs) {
      this.hits++;
      if (!this.pending.has(key)) {
        this.refresh(key, producer, ttlMs).catch(() => {});
      }
      return stale.value;
    }

    if (this.pending.has(key)) return this.pending.get(key);

    const p = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    return p;
  }

  /** Background refresh that never rejects into a caller's face. */
  async refresh(key, producer, ttlMs) {
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      try {
        const value = await producer();
        this.set(key, value, ttlMs);
        return value;
      } catch {
        return this.map.get(key)?.value; // keep the old value on failure
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, p);
    return p;
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs, hits: 0 });
    this.evict();
  }

  touch(key, e) {
    e.hits++;
    this.map.delete(key);
    this.map.set(key, e); // re-insert = most recently used
  }

  /** Drop the least recently used entries once over capacity. */
  evict() {
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
    this.pending.clear();
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      size: this.map.size,
      inFlight: this.pending.size,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : null,
    };
  }
}
