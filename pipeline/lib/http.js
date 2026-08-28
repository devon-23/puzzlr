/** Throttled, retrying JSON fetch shared by the seed and hydrate stages. */

const UA = 'puzzlr/0.1 (lyric-chain game; contact: devon.barclay23@gmail.com)';

/** Token-bucket limiter — resolves callers at no more than `rps` per second. */
export function createLimiter(rps) {
  const interval = 1000 / rps;
  let next = 0;
  return async function take() {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + interval;
    if (at > now) await sleep(at - now);
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

/**
 * Fetch JSON with retry and exponential backoff.
 * Returns `null` for a clean 404 — a missing record is data, not a failure.
 */
export async function fetchJson(url, { limiter, retries = 4, timeoutMs = 15000 } = {}) {
  let delay = 600;
  for (let attempt = 0; ; attempt++) {
    if (limiter) await limiter();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) throw new HttpError(res.status, url);
      if (!res.ok) throw new HttpError(res.status, url);

      const body = await res.json();

      // Deezer signals quota exhaustion with a 200 and an error envelope.
      if (body && body.error && Object.keys(body.error).length) {
        const code = body.error.code;
        if (code === 4 || code === 700) throw new HttpError(429, url); // rate limited
        return null; // genuine "no such record"
      }
      return body;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(delay + Math.random() * 300);
      delay = Math.min(delay * 2, 10000);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Run `worker` over `items` with bounded concurrency, preserving no order. */
export async function pool(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}
