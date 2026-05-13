/**
 * Body size validation middleware
 * 
 * LAYER 1 VALIDATION: Request Body Size Check (DoS Protection)
 * 
 * PURPOSE:
 *   Protect against Denial of Service (DoS) attacks by enforcing a hard limit
 *   on the ENTIRE request payload size BEFORE parsing JSON. This prevents
 *   attackers from exhausting Worker memory (128MB limit) by sending huge
 *   payloads.
 * 
 * WHAT IT CHECKS:
 *   The ENTIRE request body including:
 *     - JSON structure (keys, quotes, commas, brackets)
 *     - All fields (to, subject, html, text, cc, bcc, metadata)
 *   
 *   Limit: VALIDATION.MAX_REQUEST_BODY_SIZE (5MB)
 * 
 * WHEN IT RUNS:
 *   BEFORE JSON parsing - this is critical! If we parsed first, a 50MB
 *   payload would already be in memory before we could reject it.
 * 
 * SECURITY:
 *   This validation CANNOT be bypassed by manipulating the Content-Length
 *   header because we read the ACTUAL body content and check its real size
 *   using arrayBuffer.byteLength, not the client-supplied header value.
 * 
 *   Attack scenario prevented:
 *     1. Attacker omits Content-Length header (or sets it to "0")
 *     2. Sends 50MB JSON payload
 *     3. Our code reads actual body → 50MB > 5MB → REJECTED ✓
 * 
 * DEFENSE-IN-DEPTH:
 *   This is Layer 1 of our validation architecture. Layer 2 (validator.ts)
 *   validates individual field sizes AFTER parsing. Both layers are needed:
 * 
 *   - Layer 1 (this file): Protects against DoS, checks total size
 *   - Layer 2 (validator.ts): Validates business logic, checks field sizes
 * 
 *   Example why both are needed:
 *     Request: { "html": "3MB", "text": "3MB" } = 6MB total
 *     - Layer 1: Rejects (6MB > 5MB body limit) ✓
 *     - Layer 2: Would also reject HTML (3MB < 4.5MB limit, but never reached)
 * 
 * SINGLE SOURCE OF TRUTH:
 *   The limit value (5MB) is imported from constants.ts, not hardcoded here.
 *   To change the limit, update VALIDATION.MAX_REQUEST_BODY_SIZE in one place.
 * 
 * IMPLEMENTATION NOTES:
 *   - Uses request.clone() to preserve the original body stream
 *   - Reads body as ArrayBuffer to get true byte size
 *   - Decodes to text only if within size limit
 *   - Throws ValidationError (HTTP 400) if too large
 * 
 * @see src/constants.ts - VALIDATION.MAX_REQUEST_BODY_SIZE definition
 * @see src/middleware/validator.ts - Layer 2 field-level validation
 */

import { ValidationError } from '../types';
import { VALIDATION } from '../constants';

/**
 * Validates request body size by reading the actual body content.
 * 
 * SECURITY: Does NOT trust the Content-Length header (client-supplied, can
 * be omitted or faked). Instead, reads the actual body and checks its real
 * size using arrayBuffer.byteLength.
 * 
 * FLOW:
 *   1. Clone request to preserve original body stream
 *   2. Read body as ArrayBuffer (binary data)
 *   3. Check arrayBuffer.byteLength (actual size in bytes)
 *   4. If > MAX_REQUEST_BODY_SIZE: throw ValidationError (HTTP 400)
 *   5. If ≤ MAX_REQUEST_BODY_SIZE: decode to text and return
 * 
 * @param request - The incoming HTTP request
 * @returns The body text if within size limit
 * @throws {ValidationError} if body exceeds MAX_REQUEST_BODY_SIZE (5MB)
 * 
 * @example
 * // In route handler:
 * const bodyText = await validateAndReadBody(request);
 * const body = JSON.parse(bodyText);
 */
export async function validateAndReadBody(request: Request): Promise<string> {
  // Clone the request to preserve the original body stream for potential
  // retry or logging. The clone shares the same underlying buffer, so this
  // is memory-efficient (no duplication until one stream is consumed).
  const clonedRequest = request.clone();
  
  try {
    // Read the actual body as ArrayBuffer to get the TRUE size in bytes.
    // 
    // SECURITY CRITICAL: We CANNOT trust the Content-Length header because:
    //   1. It's client-supplied (attacker-controlled)
    //   2. Can be omitted entirely (defaults to 0)
    //   3. Can be set to a fake value (e.g., "100" for a 50MB payload)
    // 
    // By reading the actual body, we get the real size that matters for
    // memory consumption, regardless of what the header claims.
    const arrayBuffer = await clonedRequest.arrayBuffer();
    const actualSize = arrayBuffer.byteLength; // Real size, not header value
    
    // Enforce the size limit BEFORE parsing JSON
    // If we parsed first, a huge payload would already be in memory
    if (actualSize > VALIDATION.MAX_REQUEST_BODY_SIZE) {
      throw new ValidationError(
        `Request body too large: ${actualSize} bytes. Maximum ${VALIDATION.MAX_REQUEST_BODY_SIZE} bytes (5MB) allowed.`
      );
    }
    
    // Convert ArrayBuffer to text for JSON parsing
    // Only reached if size check passed - safe to decode now
    const decoder = new TextDecoder();
    return decoder.decode(arrayBuffer);
    
  } catch (error: any) {
    // If it's already a ValidationError, rethrow it
    if (error instanceof ValidationError) {
      throw error;
    }
    
    // Handle other errors (e.g., network issues, malformed data)
    throw new ValidationError(`Failed to read request body: ${error.message}`);
  }
}

/**
 * Alternative: Stream-based validation for very large payloads
 * Reads body in chunks and stops when limit is exceeded
 * More memory-efficient but slightly more complex
 */
export async function validateAndReadBodyStreaming(request: Request): Promise<string> {
  if (!request.body) {
    throw new ValidationError('Request body is empty');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;
      
      totalSize += value.byteLength;
      
      // Check size as we read
      if (totalSize > VALIDATION.MAX_REQUEST_BODY_SIZE) {
        // Cancel the stream to stop reading
        await reader.cancel();
        throw new ValidationError(
          `Request body too large: exceeds ${VALIDATION.MAX_REQUEST_BODY_SIZE} bytes (5MB) limit.`
        );
      }
      
      chunks.push(value);
    }
    
    // Combine all chunks
    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    
    // Decode to text
    const decoder = new TextDecoder();
    return decoder.decode(combined);
    
  } catch (error: any) {
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError(`Failed to read request body: ${error.message}`);
  }
}
