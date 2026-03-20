/**
 * Rate limiting middleware
 * 
 * Implements rate limiting using Cloudflare's native atomic rate limiter.
 * 
 * CURRENT IMPLEMENTATION:
 * - Per-minute: 60 requests per 60 seconds (enforced via native RateLimit binding)
 * 
 * CLOUDFLARE LIMITATION:
 * Native rate limiters only support 10 or 60 second periods. Hour/day windows
 * are not supported by the platform. To add hour/day limits, you would need
 * to implement KV-based counters (with eventual consistency trade-offs).
 * 
 * GLOBAL RATE LIMITING:
 * Currently uses a single "global" key, meaning all users share the same limit.
 * For per-user limits, replace "global" with a user identifier (API key hash, IP, etc.)
 */

import type { Env } from '../types';
import { RateLimitError } from '../types';

/**
 * Enforces per-minute rate limit using Cloudflare's native atomic rate limiter.
 * 
 * Architecture:
 * Uses Cloudflare's native RateLimit binding for atomic enforcement at the edge.
 * This eliminates TOCTOU race conditions and provides:
 * - Atomic counter operations (no race conditions)
 * - Zero cold-start latency
 * - Cached counters with async background updates
 * - Strong consistency guarantees
 * 
 * @param env - Cloudflare Worker environment bindings
 * @throws {RateLimitError} When rate limit is exceeded, with retryAfter in seconds
 */
export async function checkRateLimit(env: Env): Promise<void> {
  const now = Date.now();
  
  // Check minute limit using native rate limiter
  const minuteResult = await env.RATE_LIMITER_MINUTE.limit({ key: "global" });
  if (!minuteResult.success) {
    const nextMinuteBoundary = Math.ceil(now / 60000) * 60000;
    const retryAfter = Math.ceil((nextMinuteBoundary - now) / 1000);
    throw new RateLimitError('Rate limit exceeded. Try again later.', retryAfter);
  }
}


