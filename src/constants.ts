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

const ALLOWED_ORIGINS = [
  'https://skillpassport.rareminds.in',
  'https://www.skillpassport.rareminds.in',
  'http://localhost:5173',
  'http://localhost:8788',
] as const;

/**
 * Get CORS headers with dynamic origin validation
 * Only returns Access-Control-Allow-Origin for allowed origins
 */
export function getCorsHeaders(request: Request, env?: { ENVIRONMENT?: string }): Record<string, string> {
  const origin = request.headers.get('Origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Internal-Api-Key, X-API-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };

  // Check if origin is allowed
  if (origin) {
    const isLocalhost = origin.startsWith('http://localhost:');
    const isProduction = env?.ENVIRONMENT === 'production';

    // In production, block localhost origins
    if (isProduction && isLocalhost) {
      // Don't set Access-Control-Allow-Origin - browser will block
      return headers;
    }

    // Check if origin is in allowlist or dynamic env list
    const envOrigins = (env as any)?.ALLOWED_ORIGINS
      ? (env as any).ALLOWED_ORIGINS.split(',').map((s: string) => s.trim())
      : [];

    if (ALLOWED_ORIGINS.includes(origin as any) || envOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
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
