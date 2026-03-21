/**
 * Constants for Shared Email API Worker
 */

export const VERSION = '1.0.0';

export const RATE_LIMITS = {
  DEFAULT_PER_MINUTE: 60,
  // Note: Hour and day limits are not enforced due to Cloudflare platform limitations.
  // Native rate limiters only support 10 or 60 second periods.
  // To implement hour/day limits, use KV-based counters (with eventual consistency trade-offs).
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

/**
 * Validation limits for email API requests
 * 
 * SINGLE SOURCE OF TRUTH: All size limits are defined here and imported by
 * validation layers. This prevents configuration drift and makes maintenance
 * easier—change limits once, apply everywhere.
 * 
 * DEFENSE-IN-DEPTH ARCHITECTURE:
 * We validate at multiple layers for security and correctness:
 * 
 * Layer 1 (bodySize.ts): Request body size check
 *   - Purpose: DoS protection, memory safety
 *   - Checks: ENTIRE request payload (JSON structure + all fields)
 *   - Limit: MAX_REQUEST_BODY_SIZE
 *   - When: BEFORE JSON parsing
 * 
 * Layer 2 (validator.ts): Field-level size checks
 *   - Purpose: Business logic validation
 *   - Checks: Individual fields (HTML, subject, etc.)
 *   - Limit: MAX_HTML_SIZE, MAX_SUBJECT_LENGTH, etc.
 *   - When: AFTER JSON parsing
 * 
 * WHY TWO DIFFERENT SIZE LIMITS?
 * 
 * The request body contains MORE than just the HTML field:
 *   - JSON structure overhead (keys, quotes, commas, brackets)
 *   - "to" field (email addresses)
 *   - "subject" field
 *   - "html" field ← Largest field
 *   - "text" field
 *   - "cc", "bcc", "metadata" fields (optional)
 * 
 * If MAX_HTML_SIZE = MAX_REQUEST_BODY_SIZE = 5MB:
 *   HTML alone = 5MB
 *   + JSON overhead + other fields = ~0.5MB
 *   = Total 5.5MB → EXCEEDS body limit! ❌
 * 
 * With MAX_HTML_SIZE = 4.5MB (90% of body size):
 *   HTML = 4.5MB
 *   + JSON overhead + other fields = ~0.5MB
 *   = Total 5MB → Within body limit ✓
 * 
 * This 10% margin accounts for:
 *   - JSON structure overhead (~200-500 bytes)
 *   - Email addresses in "to", "cc", "bcc" (~50 bytes each)
 *   - Subject line (up to 998 chars)
 *   - Optional "text" field (usually smaller than HTML)
 *   - Optional "metadata" field
 * 
 * CLOUDFLARE WORKERS CONTEXT:
 *   - Workers have 128MB memory limit
 *   - 5MB payload = ~4% of available memory
 *   - Safe for concurrent requests
 * 
 * AWS SES CONTEXT:
 *   - Maximum email size: 10MB (including all MIME encoding)
 *   - Our 5MB limit leaves room for:
 *     * Email headers
 *     * MIME multipart boundaries
 *     * Base64 encoding overhead (~33% increase)
 *     * Future attachment support
 */
export const VALIDATION = {
  /**
   * Maximum number of recipients (to + cc + bcc combined)
   * Prevents abuse and keeps within reasonable email limits
   */
  MAX_RECIPIENTS: 50,

  /**
   * Maximum subject line length in characters
   * RFC 5322 recommends 998 characters per line
   */
  MAX_SUBJECT_LENGTH: 998,

  /**
   * Maximum HTML content size: 4.5MB
   * 
   * This is 90% of MAX_REQUEST_BODY_SIZE to leave room for:
   *   - JSON structure overhead
   *   - Other fields (to, subject, text, metadata)
   * 
   * Why not 5MB? Because the request body contains more than just HTML.
   * See detailed explanation in the comment block above.
   * 
   * Validated in: src/middleware/validator.ts (Layer 2)
   */
  MAX_HTML_SIZE: 4.5 * 1024 * 1024, // 4,718,592 bytes

  /**
   * Maximum total request body size: 5MB
   * 
   * This is the ENTIRE request payload including:
   *   - JSON structure (keys, quotes, commas, brackets)
   *   - All fields (to, subject, html, text, cc, bcc, metadata)
   * 
   * Purpose: DoS protection and memory safety
   *   - Prevents memory exhaustion attacks
   *   - Protects Worker from crashes (128MB limit)
   *   - Cannot be bypassed by omitting/faking Content-Length header
   * 
   * Why 5MB? Balance between:
   *   - Allowing rich HTML emails with embedded images (base64)
   *   - Protecting against DoS attacks
   *   - Staying well within Cloudflare Workers memory limits
   *   - Leaving room for AWS SES MIME encoding overhead
   * 
   * Validated in: src/middleware/bodySize.ts (Layer 1)
   */
  MAX_REQUEST_BODY_SIZE: 5 * 1024 * 1024, // 5,242,880 bytes
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
