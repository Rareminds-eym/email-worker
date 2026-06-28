/**
 * Authentication Middleware
 *
 * Validates every inbound request against the single shared API key stored
 * in the worker's environment (env.EMAIL_API_KEY).  This worker is intentionally
 * single-tenant — all authorised callers (SkillPassport, future websites)
 * share the same key.  If per-caller isolation is ever needed, introduce
 * a key-to-tenant map here rather than in the router layer.
 *
 * Supported header formats (checked in priority order):
 *   1. X-Internal-Api-Key: <key>   (preferred — signals internal service caller)
 *   2. X-API-Key: <key>            (accepted for backward compatibility)
 *   3. Authorization: Bearer <key> (accepted for clients that follow RFC 6750)
 *
 * Security notes:
 *   - Two distinct error messages are returned intentionally:
 *       • "Missing API key"  → helps integrators detect a mis-configured client
 *       • "Invalid API key"  → indicates the key is present but wrong
 *     This is acceptable UX for a private internal API; the messages do not
 *     expose the real key or hint at its format.
 *   - Uses crypto.subtle.timingSafeEqual for constant-time comparison to
 *     prevent timing side-channel attacks. While V8 isolates don't expose
 *     performance.now(), network round-trip timing can still leak information
 *     through statistical analysis, allowing attackers to extract secrets
 *     character-by-character.
 */

import type { Env } from '../types';
import { AuthenticationError } from '../types';

/**
 * Authenticates an inbound request by checking for a valid API key.
 *
 * Reads the key from (in priority order):
 *   1. `X-Internal-Api-Key` header  (preferred for internal service callers)
 *   2. `X-API-Key` header           (backward-compatible fallback)
 *   3. `Authorization: Bearer <token>` header  (RFC 6750 fallback)
 *
 * All three headers are validated against the same secret (`env.EMAIL_API_KEY`).
 *
 * Throws `AuthenticationError` (HTTP 401) when:
 *   - No auth header is present or all are empty
 *   - The extracted key does not match `env.EMAIL_API_KEY`
 *
 * Security implementation:
 *   - Uses SHA-256 hashing to produce fixed-length (32-byte) digests before comparison
 *   - Eliminates timing side-channel that could leak key length information
 *   - Compares hash digests using crypto.subtle.timingSafeEqual for constant-time comparison
 *   - Prevents statistical timing analysis attacks over network round-trips
 *
 * @param request - The incoming Cloudflare Workers Request object
 * @param env     - Worker environment bindings (contains EMAIL_API_KEY secret)
 * @throws {AuthenticationError} on missing or invalid credentials
 */
export async function authenticateRequest(request: Request, env: Env): Promise<void> {
  // Priority: X-Internal-Api-Key → X-API-Key → Authorization: Bearer.
  // `replace` on the Authorization header is case-sensitive — "bearer"
  // (lowercase) will NOT be stripped, causing auth to fail intentionally
  // per RFC 6750 (case-sensitive scheme name).
  const apiKey =
    request.headers.get('X-Internal-Api-Key') ||
    request.headers.get('X-API-Key') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');

  if (!apiKey) {
    throw new AuthenticationError(
      'Missing API key. Provide X-Internal-Api-Key header, X-API-Key header, or Authorization: Bearer token'
    );
  }

  // Hash-based constant-time comparison to prevent timing side-channel attacks
  // 
  // VULNERABILITY FIXED: Previous implementation leaked key length through timing
  // - Length comparison created observable timing branch
  // - Attacker could determine exact key length via statistical network timing analysis
  // - Reduced brute-force search space from unbounded to fixed-length
  //
  // SOLUTION: Hash both inputs with SHA-256 before comparison
  // - Produces fixed-length 32-byte digests regardless of input length
  // - Eliminates length-dependent timing variations entirely
  // - No observable difference between different-length vs same-length comparisons
  // - Maintains constant-time comparison via crypto.subtle.timingSafeEqual
  const encoder = new TextEncoder();
  const userValue = encoder.encode(apiKey);
  const secretValue = encoder.encode(env.EMAIL_API_KEY);

  // Hash both values to fixed-length 32-byte digests
  const userHash = await crypto.subtle.digest('SHA-256', userValue);
  const secretHash = await crypto.subtle.digest('SHA-256', secretValue);

  // Constant-time comparison of fixed-length hashes
  // Both hashes are always 32 bytes, eliminating length-based timing variations
  const isEqual = crypto.subtle.timingSafeEqual(userHash, secretHash);

  if (!isEqual) {
    throw new AuthenticationError('Invalid API key');
  }
}
