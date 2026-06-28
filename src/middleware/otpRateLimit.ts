/**
 * OTP-specific rate limiting middleware
 * Prevents abuse of OTP sending and verification endpoints
 */

import type { Env } from '../types';
import { RateLimitError } from '../types';
import { log } from '../middleware/logger';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

// In-memory cache for rate limiting (per worker instance)
const rateLimitCache = new Map<string, RateLimitRecord>();

const RATE_LIMITS = {
  SEND_OTP: {
    MAX_REQUESTS: 3,
    WINDOW_MS: 60 * 1000, // 1 minute
  },
  VERIFY_OTP: {
    MAX_REQUESTS: 5,
    WINDOW_MS: 60 * 1000, // 1 minute
  },
};

/**
 * Check rate limit for OTP operations
 */
export function checkOTPRateLimit(
  identifier: string,
  type: 'SEND_OTP' | 'VERIFY_OTP'
): void {
  const now = Date.now();
  const config = RATE_LIMITS[type];
  const key = `otp_${type}_${identifier}`;

  const record = rateLimitCache.get(key);

  if (!record) {
    // First request
    rateLimitCache.set(key, {
      count: 1,
      resetAt: now + config.WINDOW_MS,
    });
    return;
  }

  // Reset if window expired
  if (now > record.resetAt) {
    rateLimitCache.set(key, {
      count: 1,
      resetAt: now + config.WINDOW_MS,
    });
    return;
  }

  // Check if limit exceeded
  if (record.count >= config.MAX_REQUESTS) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    log('warn', 'OTP rate limit exceeded', { identifier, type });
    throw new RateLimitError(
      'Too many requests. Please try again later.',
      retryAfter
    );
  }

  // Increment count
  record.count++;
}

/**
 * Cleanup expired rate limit records (call periodically)
 */
export function cleanupExpiredRateLimits(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const [key, record] of rateLimitCache.entries()) {
    if (now > record.resetAt) {
      rateLimitCache.delete(key);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log('info', 'OTP rate limit cache cleaned', { cleaned });
  }
}
