/**
 * Constants for Shared Email API Worker
 */

export const VERSION = '1.0.0';

export const RATE_LIMITS = {
  DEFAULT_PER_MINUTE: 20,
  DEFAULT_PER_HOUR: 500,
  DEFAULT_PER_DAY: 5000,
} as const;

export const TIMEOUTS = {
  SMTP_CONNECTION: 10000, // 10 seconds
  EMAIL_SEND: 8000, // 8 seconds, prevents 3 retries from busting CF 30s limits
} as const;

export const RETRY = {
  MAX_ATTEMPTS: 3,
  INITIAL_DELAY_MS: 500,
  MAX_DELAY_MS: 3000, // Hard ceiling prevents hanging socket waits
  BACKOFF_MULTIPLIER: 2,
} as const;

export const VALIDATION = {
  MAX_RECIPIENTS: 50,
  MAX_SUBJECT_LENGTH: 998,
  MAX_HTML_SIZE: 1024 * 1024, // 1MB
} as const;

/**
 * Get CORS headers driven entirely by the ALLOWED_ORIGINS environment variable.
 *
 * No origins are hardcoded. The full list lives in Cloudflare's secret store
 * (set via `wrangler secret put ALLOWED_ORIGINS`) so it can be updated without
 * a code change or redeploy.
 *
 * For local dev, set ALLOWED_ORIGINS in your .dev.vars file.
 *
 * Behaviour:
 *   - No Origin header (curl, server-to-server) → passes through, no ACAO set.
 *   - ENVIRONMENT === 'production' + localhost origin → always blocked.
 *   - Origin found in ALLOWED_ORIGINS list → ACAO set to that origin.
 *   - Origin not in list → ACAO not set, browser blocks the response.
 */
export function getCorsHeaders(
  request: Request,
  env?: { ENVIRONMENT?: string; ALLOWED_ORIGINS?: string }
): Record<string, string> {
  const origin = request.headers.get('Origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Internal-Api-Key, X-API-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };

  if (!origin) return headers;

  // Block localhost in production regardless of ALLOWED_ORIGINS value
  if (env?.ENVIRONMENT === 'production' && origin.startsWith('http://localhost:')) {
    return headers;
  }

  // Parse the secret — single source of truth for allowed origins
  const allowedOrigins = env?.ALLOWED_ORIGINS
    ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  if (allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

export const ERROR_CODES = {
  AUTH_ERROR: 'AUTH_ERROR',
  RATE_LIMIT_ERROR: 'RATE_LIMIT_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
