/**
 * HTTP client — one place that owns timeouts, retries, and politeness.
 *
 * Every outbound call in the app goes through here, which is what makes the
 * polite behaviour (rate limiting, backoff, connection reuse) enforceable
 * rather than something each call site has to remember.
 *
 * Patterns taken from the reviewed trading codebases:
 *  - `quantdinger/.../circuit_breaker.py` — a source that is failing gets
 *    skipped entirely until it has had time to recover, instead of paying a
 *    timeout on every call.
 *  - `hummingbot/.../xrpl_utils.py:600` — a bounded sliding-window request
 *    meter, so we self-throttle *before* a 429 rather than reacting to one.
 *  - `Retry-After` is honoured when a server does throttle us, because
 *    ignoring it is how an IP gets blocked outright.
 *
 * Zero dependencies: Node 20+ ships fetch (undici) with keep-alive and
 * connection pooling built in.
 */

const DEFAULTS = { timeoutMs: 8000, retries: 2, userAgent: "beast-trader/0.1 (market data poller)" };

/** Per-host circuit state. */
const breakers = new Map();
const BREAKER = { threshold: 4, cooldownMs: 60_000 };

/** Per-host sliding request log (timestamps inside a 10s window). */
const requestLog = new Map();
const RATE = { windowMs: 10_000, maxPerWindow: 40 };

/** Minimum spacing between calls to one host, so bursts become a smooth stream. */
const MIN_GAP_MS = 60;
const lastCallAt = new Map();
const queues = new Map();

export function breakerState(host) {
  const b = breakers.get(host);
  if (!b) return { state: "closed", failures: 0 };
  if (b.state === "open" && Date.now() - b.openedAt > BREAKER.cooldownMs) {
    // Cooldown elapsed: let a single probe through to test the water.
    b.state = "half-open";
    b.probe = false;
  }
  return b;
}

function recordSuccess(host) {
  const b = breakers.get(host);
  if (b) b.failures = 0;
  if (b?.state === "half-open") {
    b.state = "closed";
    b.probe = false;
  }
}

function recordFailure(host) {
  const b = breakers.get(host) || { state: "closed", failures: 0, probe: false };
  b.failures += 1;
  if (b.state === "half-open" || b.failures >= BREAKER.threshold) {
    b.state = "open";
    b.openedAt = Date.now();
  }
  breakers.set(host, b);
}

function underRateLimit(host) {
  const now = Date.now();
  const log = (requestLog.get(host) || []).filter((t) => now - t < RATE.windowMs);
  if (log.length >= RATE.maxPerWindow) {
    requestLog.set(host, log);
    return false;
  }
  log.push(now);
  requestLog.set(host, log);
  return true;
}

/** Serialise per host and space calls out, so bursts become a smooth stream. */
function schedule(host, fn) {
  const prev = queues.get(host) || Promise.resolve();
  const next = prev.then(async () => {
    const wait = lastCallAt.get(host) ? MIN_GAP_MS - (Date.now() - lastCallAt.get(host)) : 0;
    if (wait > 0) await sleep(wait);
    lastCallAt.set(host, Date.now());
    return fn();
  });
  // Keep the chain alive even if one link rejects.
  queues.set(host, next.catch(() => {}));
  return next;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Expected, non-exceptional conditions (throttle, open breaker). */
export class SoftError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = "SoftError";
    this.kind = kind;
    this.soft = true;
  }
}

/**
 * GET JSON with timeout, retry and backoff.
 *
 * `opts.headers` are merged over the defaults, which is what lets an optional
 * API key (CoinMarketCap's `X-CMC_PRO_API_KEY`) be attached to an otherwise
 * keyless request. Defaults are applied *first* so a caller cannot accidentally
 * drop the User-Agent or the Accept header that the rate limiter relies on.
 *
 * @throws {SoftError} for 429s and open breakers, so callers can degrade
 *         instead of treating a throttle as a crash.
 */
export async function getJSON(url, opts = {}) {
  const { timeoutMs = DEFAULTS.timeoutMs, retries = DEFAULTS.retries, userAgent = DEFAULTS.userAgent, headers = {} } = opts;
  const host = new URL(url).host;

  const b = breakerState(host);
  if (b.state === "open") throw new SoftError(`${host} is recovering`, "circuit-open");
  if (b.state === "half-open" && b.probe) throw new SoftError(`${host} is recovering`, "circuit-probe");
  if (b.state === "half-open") b.probe = true;
  if (!underRateLimit(host)) throw new SoftError(`${host} rate limit`, "self-throttle");

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt));
    try {
      const json = await schedule(host, async () => {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "application/json", "user-agent": userAgent, ...headers },
        });
        if (res.status === 429 || res.status === 503) {
          // Respect the server's own pacing instruction.
          const ra = Number(res.headers.get("retry-after")) * 1000;
          if (ra > 0 && ra < 5000) await sleep(ra);
          throw new SoftError(`${host} -> ${res.status}`, "throttled");
        }
        if (!res.ok) {
          const err = new Error(`${host} -> ${res.status}`);
          err.hard = true;
          // The status is attached so callers can react to the specific code
          // (a 401 means the credential is wrong; a 404 means the path is) rather
          // than parsing the message string.
          err.status = res.status;
          throw err;
        }
        return res.json();
      });
      recordSuccess(host);
      return json;
    } catch (e) {
      lastErr = e;
      if (e.soft) {
        // Sustained throttling still means we should stand down for a while.
        if (e.kind === "throttled") recordFailure(host);
        throw e;
      }
      lastErr = e.name === "TimeoutError" || e.name === "AbortError" ? new Error(`${host} timed out`) : e;
      recordFailure(host);
    }
  }
  throw lastErr ?? new Error(`${host} request failed`);
}

/** Exponential backoff with jitter, so concurrent retries desynchronise. */
function backoffMs(attempt) {
  const base = Math.min(250 * 2 ** (attempt - 1), 4000);
  return base + Math.floor(Math.random() * 120);
}

/** Test seam: forget all learned state. */
export function resetClientState() {
  breakers.clear();
  requestLog.clear();
  lastCallAt.clear();
  queues.clear();
}

/** Test seam: current health of every host we have talked to. */
export function clientHealth() {
  return [...breakers.entries()].map(([host, b]) => ({ host, state: b.state, failures: b.failures }));
}
