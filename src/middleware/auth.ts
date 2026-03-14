/**
 * Authentication Middleware
 *
 * Validates every inbound request against the single shared API key stored
 * in the worker's environment (env.API_KEY).  This worker is intentionally
 * single-tenant — all authorised callers (SkillPassport, future websites)
 * share the same key.  If per-caller isolation is ever needed, introduce
 * a key-to-tenant map here rather than in the router layer.
 *
 * Supported header formats:
 *   - X-API-Key: <key>            (preferred — explicit, no prefix to strip)
 *   - Authorization: Bearer <key> (accepted for clients that follow RFC 6750)
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
 * Reads the key from either:
 *   1. `X-API-Key` header  (checked first)
 *   2. `Authorization: Bearer <token>` header  (fallback)
 *
 * Throws `AuthenticationError` (HTTP 401) when:
 *   - Neither header is present or both are empty
 *   - The extracted key does not match `env.API_KEY`
 *
 * @param request - The incoming Cloudflare Workers Request object
 * @param env     - Worker environment bindings (contains API_KEY secret)
 * @throws {AuthenticationError} on missing or invalid credentials
 */
export function authenticateRequest(request: Request, env: Env): void {
  // Prefer X-API-Key; fall back to stripping the "Bearer " prefix from
  // the Authorization header.  `replace` only removes the first occurrence
  // and is case-sensitive — "bearer" (lowercase) will NOT be stripped and
  // will fail auth, which is intentional per RFC 6750 (case-sensitive scheme).
  const apiKey =
    request.headers.get('X-API-Key') ||
    request.headers.get('Authorization')?.replace('Bearer ', '');

  if (!apiKey) {
    throw new AuthenticationError(
      'Missing API key. Provide X-API-Key header or Authorization: Bearer token'
    );
  }

  if (apiKey !== env.API_KEY) {
    throw new AuthenticationError('Invalid API key');
  }
}
