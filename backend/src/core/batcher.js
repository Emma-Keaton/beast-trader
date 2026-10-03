/**
 * Debounced request batching.
 *
 * Ported from `nautilus_trader/.../polymarket/data.py:281-313`, where N
 * concurrent "load instrument X" requests register futures that a single
 * debounced flush drains and loads in one batch.
 *
 * The value here: if six watchlist coins all need refreshing, we issue one
 * batched call rather than six separate ones — which is the difference
 * between one request and six on a free tier.
 */

export class Batcher {
  /**
   * @param flushMs  how long to wait for more requests before flushing
   * @param run      `(keys) => Promise<Map<key, value>>` — must resolve every key
   */
  constructor({ flushMs = 40, run }) {
    this.flushMs = flushMs;
    this.run = run;
    this.waiting = new Map(); // key -> [resolve, reject]
    this.timer = null;
    this.batches = 0;
  }

  /** Request one key. Callers sharing a key share the same upstream call. */
  request(key) {
    if (this.waiting.has(key)) {
      return new Promise((resolve, reject) => this.waiting.get(key).push({ resolve, reject }));
    }
    const p = new Promise((resolve, reject) => this.waiting.set(key, [{ resolve, reject }]));
    this.schedule();
    return p;
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      // Clear before flushing so requests arriving during the flush start a
      // new round instead of waiting on this one (nautilus:310).
      this.timer = null;
      this.flush();
    }, this.flushMs);
    this.timer.unref?.();
  }

  async flush() {
    const batch = this.waiting;
    this.waiting = new Map();
    this.batches++;
    const keys = [...batch.keys()];
    let results;
    try {
      results = await this.run(keys);
    } catch (e) {
      for (const waiters of batch.values()) for (const w of waiters) w.reject(e);
      return;
    }
    for (const [key, waiters] of batch) {
      // A key the batch could not resolve must fail loudly rather than
      // resolve to undefined and be mistaken for "no data".
      if (!results.has(key)) {
        const err = new Error(`batch miss: ${key}`);
        err.soft = true;
        for (const w of waiters) w.reject(err);
      } else {
        for (const w of waiters) w.resolve(results.get(key));
      }
    }
  }

  stats() {
    return { pending: this.waiting.size, batches: this.batches };
  }
}
