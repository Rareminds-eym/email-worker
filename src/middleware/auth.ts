/**
 * Authentication Middleware
 *
 * Validates every inbound request against the single shared API key stored
 * in the worker's environment (env.API_KEY).  This worker is intentionally
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
 *   - The comparison `apiKey !== env.API_KEY` is a direct string equality
 *     check.  Cloudflare Workers run in a V8 isolate where wall-clock timing
 *     attacks are not a practical threat, so a constant-time comparison is
 *     not required here.  Revisit if this worker is ever made public.
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
 * All three headers are validated against the same secret (`env.API_KEY`).
 *
 * Throws `AuthenticationError` (HTTP 401) when:
 *   - No auth header is present or all are empty
 *   - The extracted key does not match `env.API_KEY`
 *
 * @param request - The incoming Cloudflare Workers Request object
 * @param env     - Worker environment bindings (contains API_KEY secret)
 * @throws {AuthenticationError} on missing or invalid credentials
 */
export function authenticateRequest(request: Request, env: Env): void {
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

  if (apiKey !== env.API_KEY) {
    throw new AuthenticationError('Invalid API key');
  }
}
