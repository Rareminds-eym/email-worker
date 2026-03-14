/**
 * Structured Logging Middleware
 *
 * Emits every log entry as a single-line JSON object.  Structured JSON is
 * the correct format for Cloudflare Workers because:
 *   - Wrangler `tail` can filter and pretty-print JSON fields in real time
 *   - Cloudflare Logpush (if enabled) ingests the JSON directly into
 *     observability platforms (Datadog, Splunk, R2, etc.) without extra parsing
 *   - Plain-text multi-line logs are fragile in distributed systems where
 *     lines from concurrent requests interleave unpredictably
 *
 * Log level → console method mapping:
 *   - 'error'  → console.error()  (routes to Workers error stream)
 *   - 'warn'   → console.warn()   (routes to Workers warning stream)
 *   - 'info'   → console.log()    (standard output)
 *   - 'debug'  → console.log()    (standard output; filter at ingestion)
 *
 * IMPORTANT — spread ordering in `logData`:
 *   The `...data` spread comes AFTER the fixed fields (timestamp, level,
 *   message).  If a caller accidentally passes a `data` object that contains
 *   keys named `timestamp`, `level`, or `message`, those fields will be
 *   overwritten silently.  This is an accepted trade-off for simplicity.
 *   If strict field protection is required, nest `data` under a `context`
 *   key instead of spreading it flat.
 */

/** Union of all supported log severity levels. */
type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * Core logging primitive.  All other log helpers delegate to this function.
 *
 * Serialises the log entry to a single-line JSON string and writes it to
 * the appropriate console stream based on `level`.  Using the correct
 * console method matters in Cloudflare Workers — `console.error` and
 * `console.warn` route to separate streams that can be filtered
 * independently in `wrangler tail` and Logpush pipelines.
 *
 * @param level   - Severity level of the log entry
 * @param message - Human-readable summary of the event
 * @param data    - Optional extra fields merged into the JSON payload
 */
export function log(level: LogLevel, message: string, data?: any) {
  const timestamp = new Date().toISOString();

  // Build a flat JSON object.  Fixed fields are declared first so that
  // any conflicting keys in `data` do NOT overwrite them (spread order).
  const logData = {
    timestamp,
    level,
    message,
    ...data, // caller-supplied context (method, url, status, etc.)
  };

  // Route to the correct console stream so Cloudflare's log pipeline
  // can categorise entries by severity without parsing the JSON body.
  if (level === 'error') {
    console.error(JSON.stringify(logData));
  } else if (level === 'warn') {
    console.warn(JSON.stringify(logData));
  } else {
    // Both 'info' and 'debug' go to stdout.  To suppress debug logs in
    // production, filter on the `level` field in your Logpush query or
    // wrap this in an env-based guard if volume becomes a concern.
    console.log(JSON.stringify(logData));
  }
}

/**
 * Logs an incoming HTTP request at INFO level.
 *
 * Called after authentication succeeds so that unauthenticated probes and
 * scanners are not recorded, reducing log noise.  The `context` parameter
 * is reserved for future per-request tracing data (e.g. a correlation ID);
 * pass `null` until that is implemented.
 *
 * @param request - The incoming Request object
 * @param context - Optional per-request metadata (tracing, tenant info, etc.)
 */
export function logRequest(request: Request, context: any) {
  log('info', 'Incoming request', {
    method: request.method,
    url: request.url,
    context,
  });
}

/**
 * Logs an outgoing HTTP response at INFO level, including round-trip duration.
 *
 * `duration` is computed as `Date.now() - startTime` at the call site in
 * `index.ts`, capturing the full worker processing time including SES latency.
 * This metric is the primary indicator of P99 latency in production.
 *
 * @param request  - The original Request (for method + URL correlation)
 * @param response - The Response that will be sent to the client
 * @param context  - Optional per-request metadata (matches logRequest context)
 * @param duration - Total processing time in milliseconds
 */
export function logResponse(
  request: Request,
  response: Response,
  context: any,
  duration: number
) {
  log('info', 'Response sent', {
    method: request.method,
    url: request.url,
    status: response.status,
    duration: `${duration}ms`,
    context,
  });
}

/**
 * Logs an error at ERROR level, capturing the full stack trace when available.
 *
 * Uses `error.stack` (full trace) over `error.toString()` (type + message only)
 * so that Cloudflare Tail and any downstream log aggregator can pinpoint the
 * exact line that threw.  In Cloudflare Workers, stack traces are preserved
 * in dev and staging; in production they may be minified — consider source
 * maps if deep production debugging is needed.
 *
 * @param error   - The caught error (any type, defensive handling applied)
 * @param context - Optional extra fields to attach (e.g. `{ path: '/send' }`)
 */
export function logError(error: any, context?: any) {
  log('error', error.message || 'Unknown error', {
    // Prefer `.stack` (includes message + file + line) over `.toString()`
    // (message only).  Both are strings; the ternary avoids a redundant
    // object serialisation if the error is a plain string throw.
    error: error.stack || error.toString(),
    ...context,
  });
}
