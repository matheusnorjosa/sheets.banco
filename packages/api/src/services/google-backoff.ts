/**
 * Retry-with-backoff for Google API calls.
 *
 * Patterns combined from:
 *   - gspread (http_client.py BackOffHTTPClient): retries on 429/408/5xx and
 *     403 when domain === "usageLimits". Wait = min(2^n, 128)s.
 *   - googleworkspace/cli (Rust): honors Retry-After header, caps at 60s to
 *     defend against hostile servers, limits to 3 attempts total.
 *
 * Deliberately narrow: only transient/quota errors retry. Real permission
 * (403 not-quota), missing-sheet (404), invalid range (400) all pass through
 * unchanged — so PR #22's OOB handling and PR #25's hidden-sheet behavior
 * remain intact.
 */

export interface BackoffOptions {
  /** Total attempts (incl. the first try). Default 3. */
  attempts?: number;
  /** Cap for honoring Retry-After header (ms). Default 60000. */
  maxRetryAfterMs?: number;
  /** Base for exponential delay (ms). Default 1000. */
  baseMs?: number;
  /** Cap for exponential base (ms). Default 32000. */
  maxBaseMs?: number;
  /**
   * Optional sleep implementation (for tests). Default uses setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS: Required<Omit<BackoffOptions, 'sleep'>> & { sleep: (ms: number) => Promise<void> } = {
  attempts: 3,
  maxRetryAfterMs: 60_000,
  baseMs: 1_000,
  maxBaseMs: 32_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** True when the error from googleapis is worth retrying. */
export function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'number') return false;
  if (code === 408 || code === 429) return true;
  if (code >= 500 && code < 600) return true;
  if (code === 403) {
    // 403 is normally a real permission denial — do NOT retry that.
    // EXCEPTION: Google uses 403 + reason ∈ {rateLimitExceeded,
    // userRateLimitExceeded, quotaExceeded} to signal a transient quota cap.
    const errors = (err as { errors?: Array<{ reason?: string; domain?: string }> }).errors;
    const reason = Array.isArray(errors) ? errors[0]?.reason : undefined;
    const domain = Array.isArray(errors) ? errors[0]?.domain : undefined;
    return (
      reason === 'rateLimitExceeded' ||
      reason === 'userRateLimitExceeded' ||
      reason === 'quotaExceeded' ||
      domain === 'usageLimits'
    );
  }
  return false;
}

/**
 * Extract Retry-After (in milliseconds) from the error if Google sent it.
 * Accepts either seconds-as-integer or HTTP-date. Returns null when absent.
 */
export function parseRetryAfter(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const resp = (err as { response?: { headers?: Record<string, string | string[] | undefined> } }).response;
  const headers = resp?.headers;
  if (!headers) return null;
  // Header names from Google can be either case.
  const rawHeader = headers['retry-after'] ?? headers['Retry-After'];
  const raw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!raw) return null;
  // Seconds as integer (most common case from Google).
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && asNum >= 0) return Math.floor(asNum * 1000);
  // HTTP-date fallback.
  const asDate = Date.parse(String(raw));
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/**
 * Compute the delay (ms) before the next attempt. Honors Retry-After if
 * present (capped); otherwise uses capped exponential with full jitter
 * (AWS-style: random(0, min(base * 2^n, maxBase))).
 */
export function computeDelay(
  err: unknown,
  attempt: number,
  opts: { maxRetryAfterMs: number; baseMs: number; maxBaseMs: number },
): number {
  const retryAfter = parseRetryAfter(err);
  if (retryAfter !== null) {
    return Math.min(retryAfter, opts.maxRetryAfterMs);
  }
  const exp = Math.min(opts.baseMs * Math.pow(2, attempt), opts.maxBaseMs);
  return Math.floor(Math.random() * exp);
}

/**
 * Wrap a Google API call with retry + backoff.
 *
 * - Calls fn(); returns its value on success.
 * - On a retryable error, sleeps and retries up to `attempts` total times.
 * - On a non-retryable error (permission, 404, malformed range, etc.), throws
 *   immediately so the caller's existing error handling stays accurate.
 * - On the final attempt, throws the last error regardless.
 */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const cfg = { ...DEFAULTS, ...opts };
  let lastErr: unknown;
  for (let attempt = 0; attempt < cfg.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const last = attempt === cfg.attempts - 1;
      if (last || !isRetryable(err)) throw err;
      const delay = computeDelay(err, attempt, {
        maxRetryAfterMs: cfg.maxRetryAfterMs,
        baseMs: cfg.baseMs,
        maxBaseMs: cfg.maxBaseMs,
      });
      await cfg.sleep(delay);
    }
  }
  // Unreachable: the loop body always returns or throws. Satisfies TS.
  throw lastErr;
}
