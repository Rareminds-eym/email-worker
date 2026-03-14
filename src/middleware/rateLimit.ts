/**
 * Rate limiting middleware
 * 
 * Implements a three-tier rate limiting strategy:
 * 1. Per-minute: Cloudflare native rate limiter (atomic, distributed)
 * 2. Per-hour: KV-based soft limit (eventually consistent)
 * 3. Per-day: KV-based soft limit (eventually consistent)
 */

import type { Env, RateLimitInfo } from '../types';
import { RateLimitError } from '../types';
import { RATE_LIMITS } from '../constants';

/**
 * Enforces rate limits across three time windows: minute, hour, and day.
 * 
 * Architecture decisions:
 * - Per-minute uses Cloudflare's native RateLimit binding for atomic enforcement
 *   at the edge with zero cold-start latency and no KV consistency concerns.
 * - Per-hour and per-day use KV for cost efficiency (native rate limiters are
 *   billed per request; KV reads are cheaper at scale). These are "soft" limits
 *   due to eventual consistency but acceptable for longer windows.
 * 
 * Time bucketing:
 * - Minute buckets: Math.floor(now / 60000) creates aligned 60-second windows
 * - Hour buckets: Math.floor(now / 3600000) creates aligned 1-hour windows
 * - Day buckets: Math.floor(now / 86400000) creates aligned UTC day windows
 * 
 * @param env - Cloudflare Worker environment bindings
 * @throws {RateLimitError} When any rate limit is exceeded, with retryAfter in seconds
 */
export async function checkRateLimit(env: Env): Promise<void> {
  const now = Date.now();
  
  // ============================================================================
  // TIER 1: Per-minute rate limit (atomic enforcement via native binding)
  // ============================================================================
  // The native rate limiter provides strong consistency and is ideal for
  // short-duration windows where precision matters. Uses a global key since
  // we're rate limiting the entire API, not per-user.
  const minuteResult = await env.RATE_LIMITER_MINUTE.limit({ key: "global" });
  if (!minuteResult.success) {
    // Calculate seconds remaining until the next minute boundary
    const nextMinuteBoundary = Math.ceil(now / 60000) * 60000;
    const retryAfter = Math.ceil((nextMinuteBoundary - now) / 1000);
    throw new RateLimitError('Rate limit exceeded. Try again later.', retryAfter);
  }
  
  // ============================================================================
  // TIER 2 & 3: Per-hour and per-day rate limits (KV-based soft enforcement)
  // ============================================================================
  // Generate time-bucketed keys for the current hour and day windows.
  // These keys naturally expire as time progresses to new buckets.
  const hourKey = `rate:hour:${Math.floor(now / 3600000)}`;
  const dayKey = `rate:day:${Math.floor(now / 86400000)}`;
  
  // Fetch both counters concurrently to minimize latency (parallel I/O)
  const [hourValue, dayValue] = await Promise.all([
    env.RATE_LIMIT_KV.get(hourKey),
    env.RATE_LIMIT_KV.get(dayKey),
  ]);
  
  // Parse stored counts, defaulting to 0 for new buckets
  const hourCount = hourValue ? parseInt(hourValue) : 0;
  const dayCount = dayValue ? parseInt(dayValue) : 0;
  
  // Check if hourly limit has been reached
  if (hourCount >= RATE_LIMITS.DEFAULT_PER_HOUR) {
    // Calculate seconds remaining until the next hour boundary
    const nextHourBoundary = Math.ceil(now / 3600000) * 3600000;
    const retryAfter = Math.ceil((nextHourBoundary - now) / 1000);
    throw new RateLimitError('Hourly rate limit exceeded. Try again later.', retryAfter);
  }
  
  // Check if daily limit has been reached
  if (dayCount >= RATE_LIMITS.DEFAULT_PER_DAY) {
    // Calculate seconds remaining until the next UTC day boundary
    const nextDayBoundary = Math.ceil(now / 86400000) * 86400000;
    const retryAfter = Math.ceil((nextDayBoundary - now) / 1000);
    throw new RateLimitError('Daily rate limit exceeded. Try again later.', retryAfter);
  }
  
  // ============================================================================
  // Increment counters for both windows
  // ============================================================================
  // Write both increments concurrently for performance. TTLs are set to 2x the
  // window duration to handle edge cases around bucket transitions and clock skew.
  // - Hour TTL: 7200s (2 hours) ensures cleanup even if requests span bucket boundaries
  // - Day TTL: 172800s (2 days) provides similar safety margin for daily buckets
  await Promise.all([
    env.RATE_LIMIT_KV.put(hourKey, (hourCount + 1).toString(), {
      expirationTtl: 7200, // 2 hours in seconds
    }),
    env.RATE_LIMIT_KV.put(dayKey, (dayCount + 1).toString(), {
      expirationTtl: 172800, // 2 days in seconds
    }),
  ]);
}

/**
 * Retrieves current rate limit status for informational purposes.
 * 
 * IMPORTANT LIMITATION:
 * This function cannot accurately report per-minute usage because Cloudflare's
 * native RateLimit binding does not expose the current request count. The
 * per-minute fields (allowed, remaining, retryAfter) will always show optimistic
 * values (allowed=true, remaining=60, retryAfter=undefined).
 * 
 * The hourly and daily remaining counts ARE accurate since they're tracked in KV.
 * 
 * Current status: This function has zero call sites in the codebase. It exists
 * as a utility for potential future use cases like:
 * - Populating X-RateLimit-* response headers
 * - Admin dashboards showing rate limit consumption
 * - Client-side rate limit awareness
 * 
 * If accurate per-minute reporting becomes necessary, consider one of:
 * 1. Dual-tracking: Maintain minute counts in KV alongside the native binding
 *    (trade-off: extra KV write cost and potential consistency issues)
 * 2. Accept limitation: Document that per-minute info is unavailable and only
 *    expose hourly/daily in headers
 * 3. Native-only: Remove KV entirely and use native rate limiters for all windows
 *    (trade-off: higher cost at scale, but perfect consistency)
 * 
 * @param env - Cloudflare Worker environment bindings
 * @returns Rate limit information with accurate hourly/daily data, optimistic minute data
 */
export async function getRateLimitInfo(env: Env): Promise<RateLimitInfo> {
  const now = Date.now();
  
  // Generate time-bucketed keys for current hour and day windows
  const hourKey = `rate:hour:${Math.floor(now / 3600000)}`;
  const dayKey = `rate:day:${Math.floor(now / 86400000)}`;
  
  // Fetch both KV counters concurrently for performance
  const [hourValue, dayValue] = await Promise.all([
    env.RATE_LIMIT_KV.get(hourKey),
    env.RATE_LIMIT_KV.get(dayKey),
  ]);
  
  // Parse stored counts, defaulting to 0 for new buckets
  const hourCount = hourValue ? parseInt(hourValue) : 0;
  const dayCount = dayValue ? parseInt(dayValue) : 0;
  
  // Calculate when the current minute window resets (next minute boundary)
  const resetAt = new Date(Math.ceil(now / 60000) * 60000);
  
  // ============================================================================
  // KNOWN LIMITATION: Per-minute data is not accurate
  // ============================================================================
  // The native RATE_LIMITER_MINUTE binding is a black box that doesn't expose
  // its internal counter. We have no way to query "how many requests have been
  // made in the current minute" without making an actual limit() call, which
  // would consume a request slot.
  // 
  // Therefore, we return optimistic defaults:
  // - remaining: Always shows the full limit (60)
  // - allowed: Always true (we can't know if the limit is actually exhausted)
  // - retryAfter: Always undefined (since allowed is always true)
  // 
  // This is acceptable because:
  // 1. This function is currently unused (zero call sites)
  // 2. The actual enforcement in checkRateLimit() is correct and authoritative
  // 3. Hourly and daily data (which ARE accurate) are more useful for monitoring
  const remaining = RATE_LIMITS.DEFAULT_PER_MINUTE;
  const allowed = true;
  
  return {
    allowed,
    remaining,
    limit: RATE_LIMITS.DEFAULT_PER_MINUTE,
    resetAt,
    retryAfter: undefined, // Cannot calculate without knowing actual usage
    hourlyRemaining: Math.max(0, RATE_LIMITS.DEFAULT_PER_HOUR - hourCount),
    dailyRemaining: Math.max(0, RATE_LIMITS.DEFAULT_PER_DAY - dayCount),
  };
}
