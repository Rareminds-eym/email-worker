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
 *   due to eventual consistency but acceptable for longer windows. Note: There is
 *   a known read-then-write race condition here for extremely high-concurrency 
 *   bursts, but the primary Native minute limiter naturally governs this intake.
 * 
 * Time bucketing:
 * - Minute buckets: Math.floor(now / 60000) creates aligned 60-second windows
 * - Hour buckets: Math.floor(now / 3600000) creates aligned 1-hour windows
 * - Day buckets: Math.floor(now / 86400000) creates aligned UTC day windows
 * 
 * @param request - The incoming Request object
 * @param env - Cloudflare Worker environment bindings
 * @throws {RateLimitError} When any rate limit is exceeded, with retryAfter in seconds
 */
export async function checkRateLimit(request: Request, env: Env): Promise<void> {
  const now = Date.now();

  // Extract API key for tenant isolation (handles Bearer tokens)
  const apiKey =
    request.headers.get('X-Internal-Api-Key') ||
    request.headers.get('X-API-Key') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
    'global';

  // ============================================================================
  // TIER 1: Per-minute rate limit (atomic enforcement via native binding)
  // ============================================================================
  // The native rate limiter provides strong consistency and is ideal for
  // short-duration windows where precision matters.
  const minuteResult = await env.RATE_LIMITER_MINUTE.limit({ key: apiKey });
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
  const hourKey = `rate:hour:${apiKey}:${Math.floor(now / 3600000)}`;
  const dayKey = `rate:day:${apiKey}:${Math.floor(now / 86400000)}`;

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

