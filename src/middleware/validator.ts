/**
 * Request Validation Middleware
 *
 * Validates and normalises the inbound POST /send request body before it
 * reaches the EmailEngine.  All validation errors throw a `ValidationError`
 * which index.ts catches and converts to an HTTP 400 response — the SES
 * provider is never called with bad data.
 *
 * Design philosophy:
 *   Validate early, fail fast.  Every check is ordered from cheapest (field
 *   presence) to most expensive (size checks), so malformed requests are
 *   rejected with minimal CPU and no KV or network I/O.
 *
 * Email address format:
 *   Validated against EMAIL_REGEX (constants.ts) — a practical RFC-5322
 *   subset.  Fully RFC-compliant validation is intentionally avoided; it is
 *   unnecessarily complex and rejects addresses that SES accepts in practice.
 *   The regex catches obvious typos (no @, no domain, spaces) without false
 *   positives on real addresses.
 *
 * `text` field is optional:
 *   If omitted, SESProvider falls back to stripping HTML tags from `html`
 *   using a simple regex (`html.replace(/<[^>]*>/g, '')`).  This is
 *   sufficient for transactional emails.  For rich marketing emails that
 *   require a carefully crafted plain-text version, callers should supply
 *   `text` explicitly.
 *
 * ℹ️  Bug fixed (2026-03-12):
 *   Previously, `cc` and `bcc` were validated via `validateEmailList()` but
 *   the RETURN VALUE (the normalised string[]) was discarded.  The original
 *   raw value from the request body was passed to SESProvider instead.  When
 *   a caller sent `"cc": "foo@bar.com"` (a string, not an array), SES
 *   responded with HTTP 400 "Expected list or null", surfaced as a 500
 *   PROVIDER_ERROR.  The fix: capture and use the array returned by
 *   `validateEmailList()` for both `cc` and `bcc`.
 */

import type { SendEmailRequest } from '../types';
import { ValidationError } from '../types';
import { EMAIL_REGEX, VALIDATION } from '../constants';

/**
 * Tests whether a single email address string is syntactically valid.
 *
 * This is a low-level primitive — it does NOT check whether the address
 * actually exists or is deliverable.  Used internally by `validateEmailList`
 * and called directly for optional single-address fields (`from`, `replyTo`).
 *
 * @param email - Raw email address string to test
 * @returns `true` if the address passes the regex, `false` otherwise
 */
export function validateEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/**
 * Validates a list of recipient email addresses and normalises the input
 * to a `string[]`, regardless of whether a single string or an array was
 * provided.
 *
 * Accepts `string | string[]` so that callers can pass a single recipient
 * without wrapping it in an array.  The normalised array is always returned
 * and MUST be used by the caller — do not use the original input value after
 * calling this function, as it may be a plain string that AWS SES will reject
 * with "Expected list or null".
 *
 * Validation order (cheapest to most expensive):
 *   1. Empty list check  (catches `[]` after normalisation)
 *   2. Max-recipients check  (short-circuits before iterating)
 *   3. Per-address format check  (O(n) regex loop)
 *
 * @param emails - A single email address or an array of email addresses
 * @returns Normalised `string[]` of validated addresses
 * @throws {ValidationError} if the list is empty, too long, or contains
 *         any syntactically invalid address
 */
export function validateEmailList(emails: string | string[]): string[] {
  // Normalise: always work with an array so downstream code (SES payload
  // builder) never has to handle the string/array union.
  const emailList = Array.isArray(emails) ? emails : [emails];

  if (emailList.length === 0) {
    throw new ValidationError('At least one recipient is required');
  }

  if (emailList.length > VALIDATION.MAX_RECIPIENTS) {
    throw new ValidationError(
      `Too many recipients. Maximum ${VALIDATION.MAX_RECIPIENTS} allowed`,
      { maxRecipients: VALIDATION.MAX_RECIPIENTS, provided: emailList.length }
    );
  }

  for (const email of emailList) {
    if (!validateEmail(email)) {
      throw new ValidationError(`Invalid email address: ${email}`);
    }
  }

  return emailList;
}

/**
 * Validates and normalises a raw POST /send request body.
 *
 * Performs all field-level validation and returns a clean `SendEmailRequest`
 * object that is safe to pass directly to `EmailEngine.send()`.  If any
 * field is invalid, a `ValidationError` is thrown and the engine is never
 * called.
 *
 * Required fields: `to`, `subject`, `html`
 * Optional fields: `text`, `from`, `fromName`, `replyTo`, `cc`, `bcc`,
 *                  `metadata`
 *
 * IMPORTANT — `cc` / `bcc` normalisation:
 *   Both fields accept `string | string[]` from the caller (matching the
 *   `to` field convention).  `validateEmailList()` normalises the input to
 *   `string[]` and validates each address.  The RETURNED array is stored in
 *   `ccList`/`bccList` and passed to the return value.  Never use the raw
 *   `cc`/`bcc` from the request body after this point — doing so bypasses
 *   normalisation and will cause SES to reject the payload.
 *
 * @param body - Raw parsed JSON body from the HTTP request (typed as `any`
 *               because it arrives untyped from the network)
 * @returns A validated, normalised `SendEmailRequest` ready for the engine
 * @throws {ValidationError} (HTTP 400) on any validation failure
 */
export function validateSendEmailRequest(body: any): SendEmailRequest {
  // Guard against non-object bodies (null, string, array, etc.).
  // Arrays pass `typeof body !== 'object'` check but fail real usage,
  // so they are correctly caught here.
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Request body must be a JSON object');
  }

  const { to, subject, html, text, from, fromName, replyTo, cc, bcc, metadata } = body;

  // --- Required field presence checks (fast-fail before any parsing) ---

  if (!to) {
    throw new ValidationError('Missing required field: to');
  }

  if (!subject) {
    throw new ValidationError('Missing required field: subject');
  }

  if (!html) {
    throw new ValidationError('Missing required field: html');
  }

  // --- Email address validation ---

  // `to` accepts string or string[]; validateEmailList normalises to string[].
  const toList = validateEmailList(to);

  // `from` and `replyTo` are single addresses — validate format if provided.
  if (from && !validateEmail(from)) {
    throw new ValidationError(`Invalid from email address: ${from}`);
  }

  if (replyTo && !validateEmail(replyTo)) {
    throw new ValidationError(`Invalid replyTo email address: ${replyTo}`);
  }

  // BUG FIX: capture the returned string[] from validateEmailList.
  // Previously the return value was discarded and the raw `cc`/`bcc` values
  // (potentially plain strings) were forwarded to SES, causing:
  //   HTTP 400 from SES: "Expected list or null"
  //   Surfaced to caller as: HTTP 500 PROVIDER_ERROR
  const ccList  = cc  ? validateEmailList(cc)  : undefined;
  const bccList = bcc ? validateEmailList(bcc) : undefined;

  // --- Size / length checks (checked after email validation to avoid
  //     running these on obviously bad input) ---

  if (subject.length > VALIDATION.MAX_SUBJECT_LENGTH) {
    throw new ValidationError(
      `Subject too long. Maximum ${VALIDATION.MAX_SUBJECT_LENGTH} characters allowed`,
      { maxLength: VALIDATION.MAX_SUBJECT_LENGTH, provided: subject.length }
    );
  }

  // HTML size is measured in characters, not bytes.  For ASCII-heavy email
  // templates this is equivalent; for multi-byte UTF-8 content the real
  // byte size will be larger.  This is a pragmatic limit; SES enforces its
  // own 10 MB payload ceiling as a hard backstop.
  if (html.length > VALIDATION.MAX_HTML_SIZE) {
    throw new ValidationError(
      `HTML content too large. Maximum ${VALIDATION.MAX_HTML_SIZE} bytes allowed`,
      { maxSize: VALIDATION.MAX_HTML_SIZE, provided: html.length }
    );
  }

  // Return the fully validated and normalised request object.
  // All email-list fields are now guaranteed to be `string[] | undefined`.
  return {
    to: toList,
    subject,
    html,
    text,       // optional; SESProvider auto-generates from html if omitted
    from,       // optional; defaults to DEFAULT_FROM_EMAIL in EmailEngine
    fromName,   // optional; defaults to DEFAULT_FROM_NAME in EmailEngine
    replyTo,    // optional; omitted from SES payload if not provided
    cc: ccList,   // normalised string[] or undefined
    bcc: bccList, // normalised string[] or undefined
    metadata,   // passed through for logging only; not sent to SES
  };
}
