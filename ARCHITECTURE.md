# Architecture — Shared Email & OTP API

This document explains the full internal architecture of the worker: how every layer is structured, why each design decision was made, and the exact flow a request takes from the moment it arrives at Cloudflare's edge to the moment a response is returned.

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Runtime Environment](#runtime-environment)
3. [Directory & Module Map](#directory--module-map)
4. [Request Lifecycle](#request-lifecycle)
5. [Email Pipeline — Deep Dive](#email-pipeline--deep-dive)
6. [OTP Pipeline — Deep Dive](#otp-pipeline--deep-dive)
7. [Middleware Layer](#middleware-layer)
8. [Rate Limiting Architecture](#rate-limiting-architecture)
9. [Error Handling System](#error-handling-system)
10. [CORS & Security Model](#cors--security-model)
11. [Logging Architecture](#logging-architecture)
12. [Type System](#type-system)
13. [Cloudflare Bindings](#cloudflare-bindings)
14. [Design Decisions & Trade-offs](#design-decisions--trade-offs)

---

## High-Level Overview

```
                        ┌─────────────────────────────────────────────────┐
                        │              Cloudflare Edge Network             │
                        │                                                  │
  HTTP Request          │   ┌──────────────┐      ┌────────────────────┐  │
  ─────────────────────►│   │  CF Worker   │      │  Cloudflare KV     │  │
                        │   │  (V8 Isolate)│◄────►│  (Rate Limit Store)│  │
  HTTP Response         │   │              │      └────────────────────┘  │
  ◄─────────────────────│   │  itty-router │                              │
                        │   │              │      ┌────────────────────┐  │
                        │   │  index.ts    │◄────►│  CF Rate Limiter   │  │
                        │   └──────┬───────┘      │  (Native, /minute) │  │
                        │          │               └────────────────────┘  │
                        └──────────┼──────────────────────────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │               │
                    ▼              ▼               ▼
             ┌────────────┐ ┌──────────┐  ┌──────────────┐
             │  POST /send│ │POST /otp/│  │  GET /health │
             │            │ │send      │  │  GET /       │
             └─────┬──────┘ └────┬─────┘  └──────────────┘
                   │             │
                   ▼             ▼
            ┌────────────┐ ┌──────────────────────┐
            │EmailEngine │ │MessageCentralService  │
            │+ SESProvider│ │(OTP via CPAAS API)   │
            └─────┬──────┘ └──────────────────────┘
                  │
                  ▼
          ┌───────────────┐
          │  AWS SES v2   │
          │  (ap-south-1) │
          └───────────────┘
```

The worker is a single Cloudflare Worker (V8 isolate) that handles two independent services:
- **Email** — accepts a JSON payload, validates it, builds a raw MIME email, signs it with AWS Signature V4, and sends it via SES v2.
- **OTP** — accepts a phone number, validates it, calls MessageCentral's CPAAS API to send or verify an OTP code.

Both services share the same authentication, CORS, logging, and error handling infrastructure.

---

## Runtime Environment

The worker runs inside a **Cloudflare V8 isolate**, not Node.js. Key implications:

- No filesystem access. All config comes from environment bindings.
- No persistent in-process memory between requests across different isolate instances (though the same isolate instance may handle multiple requests, which is why the `EmailEngine` instance cache in `send.ts` works within a single isolate lifetime).
- The `nodejs_compat` compatibility flag is enabled in `wrangler.toml`, which polyfills Node.js built-ins like `node:buffer` — used by `SESProvider` for base64 encoding.
- Global APIs like `fetch`, `crypto`, `Response`, `Request`, `AbortSignal` are available natively from the Workers runtime.
- The worker has a **30-second CPU time limit** per request. The email send timeout is set to 8 seconds (`TIMEOUTS.EMAIL_SEND`) specifically to allow up to 3 retry attempts within this budget.

---

## Directory & Module Map

```
src/
│
├── index.ts                  ← Worker entry point. Owns the router, global
│                               middleware chain, and the top-level error handler.
│
├── types.ts                  ← All TypeScript interfaces, the Env binding type,
│                               and the error class hierarchy.
│
├── constants.ts              ← Immutable values: rate limits, timeouts, retry
│                               config, validation limits, CORS allowlist,
│                               getCorsHeaders() function, EMAIL_REGEX.
│
├── config/
│   └── config.ts             ← getEmailConfig(env): validates required AWS env
│                               vars and returns a typed EmailConfig object.
│
├── core/
│   └── EmailEngine.ts        ← Orchestrates email sending. Builds the EmailMessage,
│                               generates a Message-ID, runs the retry loop with
│                               exponential backoff + jitter, delegates to SESProvider.
│
├── middleware/
│   ├── auth.ts               ← authenticateRequest(): extracts API key from one of
│   │                           three header formats, throws AuthenticationError on fail.
│   ├── logger.ts             ← Structured JSON logging. log(), logRequest(),
│   │                           logResponse(), logError() — all emit single-line JSON.
│   ├── rateLimit.ts          ← checkRateLimit(): 3-tier enforcement (minute via
│   │                           native CF binding, hour+day via KV counters).
│   ├── validator.ts          ← validateSendEmailRequest(): validates and normalises
│   │                           the POST /send body. Returns a clean SendEmailRequest.
│   ├── otpRateLimit.ts       ← checkOTPRateLimit(): in-memory per-phone rate limiting
│   │                           using a Map. 3 sends/min, 5 verifies/min.
│   └── otpValidator.ts       ← validatePhoneNumber(), validateCountryCode(),
│                               validateFlowType(), validateVerificationId(),
│                               validateOTPCode() — all throw ValidationError on fail.
│
├── providers/
│   ├── BaseProvider.ts       ← Abstract class. Defines send() and testConnection()
│   │                           contracts. Implements classifyError() for retry logic.
│   └── SESProvider.ts        ← Concrete AWS SES v2 implementation. Builds raw MIME
│                               email, signs with aws4fetch, POSTs to SES endpoint.
│
├── routes/
│   ├── send.ts               ← handleSend(): parses body, validates, checks idempotency,
│   │                           calls EmailEngine, caches success result in KV.
│   ├── otp.ts                ← handleSendOTP() and handleVerifyOTP(): validate inputs,
│   │                           check OTP rate limits, call MessageCentralService.
│   └── health.ts             ← handleHealth() (public) and handleInternalHealth()
│                               (authenticated): checks AWS creds, KV, rate limiter.
│
└── services/
    └── MessageCentralService.ts  ← OTP service client. Uses a long-lived JWT token
                                    (MESSAGECENTRAL_KEY) to call the CPAAS v3 API
                                    for send and verify operations.
```

---

## Request Lifecycle

Every request — regardless of route — passes through the same top-level pipeline in `index.ts`.

```
Incoming Request
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│  export default { fetch() }  ─── index.ts                       │
│                                                                  │
│  1. Assign requestId (cf-ray header or crypto.randomUUID())      │
│  2. Pass to router.handle(request, env, ctx)                     │
│  3. Append X-Request-Id header to every response                 │
│  4. Catch any fatal unhandled exception → 500 FATAL_ERROR        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  itty-router  ─── matches route in registration order           │
│                                                                  │
│  Step 1: OPTIONS *  → CORS preflight (204, no auth)             │
│  Step 2: ALL *      → CORS origin block (403 if not allowed)    │
│  Step 3: Route match → handler                                   │
│  Step 4: ALL *      → 404 fallback                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
              ┌────────────┼────────────────┐
              │            │                │
              ▼            ▼                ▼
        Public routes  Authenticated    OTP routes
        GET /          routes           POST /otp/send
        GET /health    POST /send       POST /otp/verify
                       GET /internal/
                       health
```

### Authenticated Route Pipeline (POST /send, POST /otp/send, POST /otp/verify)

```
Request arrives at route handler in index.ts
      │
      ├─► authenticateRequest(request, env)
      │       Extracts key from X-Internal-Api-Key → X-API-Key → Bearer
      │       Throws AuthenticationError (401) if missing or wrong
      │
      ├─► logRequest(request, { requestId })
      │       Logs method + URL as structured JSON (only after auth passes)
      │
      ├─► checkRateLimit(request, env)          [email routes only]
      │       Tier 1: CF native rate limiter (20/min, atomic)
      │       Tier 2: KV hourly counter (500/hr, eventually consistent)
      │       Tier 3: KV daily counter (5000/day, eventually consistent)
      │       Throws RateLimitError (429) with Retry-After if exceeded
      │
      ├─► handleSend / handleSendOTP / handleVerifyOTP
      │       Route-specific logic (see pipeline sections below)
      │
      ├─► getCorsHeaders() → set on response
      │
      ├─► logResponse(request, response, { requestId }, duration)
      │
      └─► return response
            │
            (on any throw)
            └─► handleError(error, request, env)
                    Matches error class → typed JSON response
                    AuthenticationError  → 401
                    RateLimitError       → 429 + Retry-After header
                    ValidationError      → 400 + details
                    OTPError             → statusCode from error
                    EmailWorkerError     → statusCode from error
                    unknown              → 500 INTERNAL_ERROR
```

---

## Email Pipeline — Deep Dive

```
POST /send
      │
      ▼
handleSend()  ─── src/routes/send.ts
      │
      ├─ 1. Content-Type check
      │       Must be application/json → ValidationError if not
      │
      ├─ 2. Content-Length check
      │       Hard limit: 2MB → ValidationError if exceeded
      │
      ├─ 3. Idempotency check
      │       If Idempotency-Key header present:
      │         KV.get("idem:<key>") → return cached response if found
      │
      ├─ 4. Parse JSON body
      │       request.json() → ValidationError on malformed JSON
      │
      ├─ 5. validateSendEmailRequest(body)  ─── src/middleware/validator.ts
      │       ├─ Body must be a non-null object
      │       ├─ Required: to, subject, html
      │       ├─ to: validateEmailList() → normalise string|string[] → string[]
      │       │       Empty list → error
      │       │       > 50 recipients → error
      │       │       Each address tested against EMAIL_REGEX
      │       ├─ from, replyTo: single address format check if provided
      │       ├─ cc, bcc: validateEmailList() → normalised string[] (bug fix: return value captured)
      │       ├─ subject: max 998 chars
      │       ├─ html: max 1MB (character count)
      │       └─ metadata: max 4KB JSON serialised
      │
      ├─ 6. getEmailConfig(env)  ─── src/config/config.ts
      │       Validates AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
      │       DEFAULT_FROM_EMAIL, DEFAULT_FROM_NAME are all present
      │       Returns typed EmailConfig object
      │
      ├─ 7. EmailEngine instance cache check
      │       Reuses cached engine if AWS_REGION and AWS_ACCESS_KEY_ID unchanged
      │       Creates new EmailEngine (and new SESProvider) if credentials changed
      │       This avoids re-initialising AwsClient on every request within the same isolate
      │
      ├─ 8. EmailEngine.send(validatedRequest)  ─── src/core/EmailEngine.ts
      │       │
      │       ├─ buildMessage(): maps SendEmailRequest → EmailMessage
      │       │       Applies DEFAULT_FROM_EMAIL / DEFAULT_FROM_NAME if from/fromName omitted
      │       │       Normalises to as string[] (already done by validator, defensive)
      │       │
      │       ├─ Generate Message-ID: <uuid@sending-domain>  (RFC 5322 §3.6.4)
      │       │
      │       └─ Retry loop (up to 3 attempts):
      │               SESProvider.send(message)
      │               If success or !shouldRetry → return immediately
      │               If shouldRetry and attempts remain:
      │                 delay = min(500ms * 2^attempt, 3000ms) ± 25% jitter
      │                 await delay, then retry
      │
      ├─ 9. SESProvider.send(message)  ─── src/providers/SESProvider.ts
      │       │
      │       ├─ buildRawEmail(message)
      │       │       Generates MIME boundary (uuid-based)
      │       │       Builds RFC 5322 headers:
      │       │         From: "Display Name" <email>  (RFC 2047 encoded if non-ASCII)
      │       │         To, Subject, Date, MIME-Version, Content-Type, Message-ID
      │       │         Optional: Reply-To, Cc
      │       │       Builds multipart/alternative body:
      │       │         Part 1: text/plain (base64) — from text field or HTML-stripped fallback
      │       │         Part 2: text/html  (base64)
      │       │       Header sanitisation: strips \r \n , < > from all header values
      │       │
      │       ├─ base64 encode raw email via node:buffer
      │       │
      │       ├─ aws4fetch signs request with AWS Signature V4
      │       │       service: 'ses' (explicit — aws4fetch would infer 'email' from hostname)
      │       │       endpoint: https://email.{region}.amazonaws.com/v2/email/outbound-emails
      │       │
      │       ├─ POST to SES v2 API with 8-second AbortSignal timeout
      │       │
      │       ├─ On HTTP error:
      │       │       429 or 5xx → ProviderError(shouldRetry=true)
      │       │       4xx → ProviderError(shouldRetry=false)
      │       │
      │       └─ On success: return { success: true, messageId: result.MessageId }
      │
      ├─ 10. On send failure: log error, return 503 (retryable) or 500
      │
      ├─ 11. On send success:
      │        If Idempotency-Key: KV.put("idem:<key>", response, TTL 24h)
      │        Return 200 with messageId, customMessageId, recipient, timestamp
      │
      └─ Any thrown error → caught by route handler in index.ts → handleError()
```

---

## OTP Pipeline — Deep Dive

### POST /otp/send

```
POST /otp/send
      │
      ▼
handleSendOTP()  ─── src/routes/otp.ts
      │
      ├─ 1. Parse JSON body → { mobileNumber, countryCode, flowType }
      │
      ├─ 2. validateCountryCode(countryCode)  ─── otpValidator.ts
      │       Default: '91' (India)
      │       Strips non-digits, must be 1-3 digits
      │
      ├─ 3. validatePhoneNumber(mobileNumber, countryCode)
      │       Strips non-digits
      │       countryCode '91': must match /^[6-9]\d{9}$/ (Indian mobile format)
      │       Other: must be 7-15 digits
      │       Returns cleaned digit-only string
      │
      ├─ 4. validateFlowType(flowType)
      │       Default: 'SMS'
      │       Accepts: 'SMS' | 'WHATSAPP' | 'RCS' (case-insensitive)
      │
      ├─ 5. checkOTPRateLimit(phoneNumber, 'SEND_OTP')  ─── otpRateLimit.ts
      │       In-memory Map keyed by "otp_SEND_OTP_<phoneNumber>"
      │       Limit: 3 requests per 60-second window
      │       Throws RateLimitError (429) with retryAfter if exceeded
      │
      ├─ 6. MessageCentralService.sendOTP(phone, countryCode, flowType)
      │       │
      │       ├─ getAuthToken(): returns MESSAGECENTRAL_KEY directly
      │       │       (long-lived JWT, no token exchange needed)
      │       │
      │       ├─ Build URL: https://cpaas.messagecentral.com/verification/v3/send
      │       │       Query params: countryCode, customerId, flowType, mobileNumber
      │       │
      │       ├─ POST with authToken header
      │       │
      │       ├─ responseCode 200 → return { verificationId, timeout, mobileNumber }
      │       │
      │       └─ Error codes mapped to OTPError:
      │               400 → INVALID_REQUEST
      │               409 → OTP_ALREADY_SENT
      │               500 → SERVICE_UNAVAILABLE
      │               511 → INVALID_COUNTRY_CODE
      │               800 → RATE_LIMIT_EXCEEDED
      │
      └─ Return 200: { success, verificationId, timeout, message }
```

### POST /otp/verify

```
POST /otp/verify
      │
      ▼
handleVerifyOTP()  ─── src/routes/otp.ts
      │
      ├─ 1. Parse JSON body → { mobileNumber, verificationId, code, countryCode }
      │
      ├─ 2. validateCountryCode + validatePhoneNumber (same as send)
      │
      ├─ 3. validateVerificationId(verificationId)
      │       Must be alphanumeric + _ - characters, 1-100 chars
      │
      ├─ 4. validateOTPCode(code)
      │       Must be 4-6 digits only
      │
      ├─ 5. checkOTPRateLimit("<phone>_<verificationId>", 'VERIFY_OTP')
      │       Limit: 5 attempts per 60-second window
      │       Key includes verificationId to prevent cross-session brute force
      │
      ├─ 6. MessageCentralService.verifyOTP(phone, verificationId, code, countryCode)
      │       │
      │       ├─ GET https://cpaas.messagecentral.com/verification/v3/validateOtp
      │       │       Query params: countryCode, mobileNumber, verificationId,
      │       │                     customerId, code
      │       │
      │       ├─ responseCode 200 → verified = (verificationStatus === 'VERIFICATION_COMPLETED')
      │       │
      │       └─ Error codes mapped to OTPError:
      │               505 → INVALID_VERIFICATION_ID
      │               700 → VERIFICATION_FAILED
      │               702 → INVALID_OTP
      │               703 → ALREADY_VERIFIED
      │               705 → OTP_EXPIRED
      │
      └─ Return 200: { success, verified, message }
             verified=true  → "Phone number verified successfully"
             verified=false → "Invalid OTP code"
```

---

## Middleware Layer

### auth.ts — Authentication

`authenticateRequest(request, env)` is a synchronous function that throws or returns void. It is called at the top of every authenticated route handler in `index.ts` before any logging or rate limiting.

Header priority order:
```
1. X-Internal-Api-Key   ← preferred (signals internal service caller)
2. X-API-Key            ← backward-compatible
3. Authorization: Bearer <token>  ← RFC 6750 fallback
```

All three are compared against the single `env.API_KEY` secret. The worker is intentionally single-tenant — all callers share one key. If per-caller isolation is needed in the future, a key-to-tenant map should be introduced here.

Two distinct error messages are returned on purpose:
- `"Missing API key"` — no header present at all (helps integrators detect misconfiguration)
- `"Invalid API key"` — header present but value is wrong

### logger.ts — Structured Logging

All log output is single-line JSON, which is the correct format for Cloudflare Workers because:
- `wrangler tail` can filter and pretty-print JSON fields in real time
- Cloudflare Logpush ingests JSON directly into observability platforms without extra parsing
- Multi-line plain text logs interleave unpredictably in distributed systems

Log level → console method mapping:
```
'error' → console.error()   routes to Workers error stream
'warn'  → console.warn()    routes to Workers warning stream
'info'  → console.log()     standard output
'debug' → console.log()     standard output
```

The spread ordering in `log()` is intentional: caller-supplied `data` is spread first, then `timestamp`, `level`, `message` are appended — so fixed fields always win over any conflicting caller keys.

`logRequest()` is called only after authentication succeeds, so unauthenticated probes and scanners are not recorded.

### validator.ts — Email Request Validation

`validateSendEmailRequest(body)` validates in cheapest-to-most-expensive order:
1. Body type check (no network/KV I/O)
2. Required field presence
3. Email format regex (O(n) per address)
4. Size/length checks (string operations)

`validateEmailList()` normalises `string | string[]` to `string[]`. The return value must always be used — the raw input must never be forwarded to SES, as SES rejects plain strings with "Expected list or null".

### otpValidator.ts — OTP Input Validation

Phone number validation is country-code-aware:
- Country code `91` (India): enforces `/^[6-9]\d{9}$/` — 10 digits starting with 6-9
- All other country codes: generic 7-15 digit check

All validators strip non-digit characters before checking, so inputs like `"98765-43210"` or `"+91 98765 43210"` are cleaned before validation.

---

## Rate Limiting Architecture

The system uses two completely separate rate limiting mechanisms for email and OTP.

### Email Rate Limiting — 3-Tier (rateLimit.ts)

```
Request
   │
   ▼
Tier 1: Cloudflare Native Rate Limiter (RATE_LIMITER_MINUTE binding)
   │   Limit: 20 requests per 60 seconds per API key
   │   Consistency: STRONG (atomic, distributed across all CF edge nodes)
   │   Cost: billed per request
   │   Key: the API key value itself
   │
   ▼ (passes)
Tier 2: KV Hourly Counter
   │   Limit: 500 requests per hour per API key
   │   Consistency: EVENTUAL (KV is eventually consistent — known race condition
   │                at very high concurrency, acceptable because Tier 1 governs intake)
   │   Key: "rate:hour:<apiKey>:<Math.floor(now/3600000)>"
   │   TTL: 7200s (2 hours — handles bucket boundary edge cases)
   │
   ▼ (passes)
Tier 3: KV Daily Counter
       Limit: 5000 requests per day per API key
       Consistency: EVENTUAL
       Key: "rate:day:<apiKey>:<Math.floor(now/86400000)>"
       TTL: 172800s (2 days)
```

Tiers 2 and 3 are fetched in parallel (`Promise.all`) and written in parallel after the checks pass, minimising KV latency impact.

Time buckets are aligned to UTC boundaries (not rolling windows). A request at 23:59 and a request at 00:01 are in different day buckets even though they are 2 minutes apart.

### OTP Rate Limiting — In-Memory (otpRateLimit.ts)

```
Map<string, { count: number, resetAt: number }>

Key format:
  SEND_OTP:   "otp_SEND_OTP_<phoneNumber>"
  VERIFY_OTP: "otp_VERIFY_OTP_<phoneNumber>_<verificationId>"

Limits:
  SEND_OTP:   3 requests per 60-second window
  VERIFY_OTP: 5 requests per 60-second window
```

This is an in-memory Map, not KV. It is scoped to a single worker isolate instance. This means:
- It resets when the isolate is recycled (typically after a period of inactivity)
- It does not share state across multiple isolate instances running in parallel on different CF edge nodes
- It is appropriate for OTP because the primary enforcement is done by MessageCentral's own rate limiting on their API side; this is a first-line abuse prevention layer

The VERIFY_OTP key includes the `verificationId` to prevent brute-forcing a single verification session from a different phone number context.

---

## Error Handling System

All errors in the system extend a single base class defined in `types.ts`:

```
Error
  └── EmailWorkerError (code, statusCode, details)
        ├── AuthenticationError  (code: AUTH_ERROR,       statusCode: 401)
        ├── RateLimitError       (code: RATE_LIMIT_ERROR, statusCode: 429, retryAfter)
        ├── ValidationError      (code: VALIDATION_ERROR, statusCode: 400, details)
        ├── ProviderError        (code: PROVIDER_ERROR,   statusCode: 500, shouldRetry)
        └── OTPError             (code: OTP_ERROR,        statusCode: 400, details)
```

The `handleError()` function in `index.ts` is the single place where all thrown errors are converted to HTTP responses. It checks `instanceof` in order and maps each class to its appropriate response shape:

- `RateLimitError` additionally sets the `Retry-After` response header
- `ValidationError` includes a `details` field in the response body
- Unknown errors (not instances of any known class) return 500 with `INTERNAL_ERROR`

Route handlers inside `routes/` also have their own try/catch for errors that should not bubble up to the router-level handler (e.g., `handleSend` catches and returns structured responses for provider failures).

The logging strategy for errors in `index.ts`:
- `AuthenticationError`, `ValidationError`, `RateLimitError` → logged at `warn` level (client errors, expected)
- All other errors → logged at `error` level with full stack trace via `logError()`

---

## CORS & Security Model

CORS is handled by `getCorsHeaders()` in `constants.ts`. It is called on every response.

### Allowed Origins — fully dynamic via secret

No origins are hardcoded in the codebase. The full list is read at runtime from `env.ALLOWED_ORIGINS`, which is stored as a Cloudflare secret (set via `wrangler secret put ALLOWED_ORIGINS`). This means allowed domains can be updated without a code change or redeploy.

For local dev, `ALLOWED_ORIGINS` is set in `.dev.vars`.

`getCorsHeaders()` signature:
```typescript
getCorsHeaders(
  request: Request,
  env?: { ENVIRONMENT?: string; ALLOWED_ORIGINS?: string }
): Record<string, string>
```

### Origin Enforcement Logic

```
Request has Origin header?
  │
  ├─ No → return headers without Access-Control-Allow-Origin
  │        (non-browser requests, curl, server-to-server — allowed through)
  │
  └─ Yes → Is ENVIRONMENT === 'production' AND origin starts with 'http://localhost:'?
              │
              ├─ Yes → block: return headers without ACAO
              │         (localhost always blocked in production, regardless of ALLOWED_ORIGINS)
              │
              └─ No → Parse env.ALLOWED_ORIGINS (split by comma, trim, filter empty)
                          │
                          ├─ Origin in list → set Access-Control-Allow-Origin: <origin>
                          └─ Not in list    → don't set ACAO (browser blocks)
```

The global `router.all('*')` middleware in `index.ts` enforces this early: if a request has an `Origin` header but `getCorsHeaders()` did not set `Access-Control-Allow-Origin`, the request is rejected with 403 before reaching any route handler. This means unapproved browser origins cannot reach authentication or any business logic.

CORS preflight (`OPTIONS *`) is handled separately and always returns 204 with the CORS headers — it does not require authentication.

---

## Logging Architecture

Every log entry is a flat JSON object emitted to stdout/stderr. Fields:

```json
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "level": "info",
  "message": "Response sent",
  "method": "POST",
  "url": "https://worker.dev/send",
  "status": 200,
  "duration": "142ms",
  "context": { "requestId": "abc123" }
}
```

The `requestId` is the Cloudflare Ray ID (`cf-ray` header) when available, falling back to `crypto.randomUUID()`. It is set at the top of the `fetch()` handler and appended to every response as `X-Request-Id`. This allows correlating a client-side error with a specific log entry in `wrangler tail` or Logpush.

Log call sites:
- `logRequest()` — called after auth passes, before rate limiting
- `logResponse()` — called after the route handler returns successfully
- `logError()` — called for server-side errors (non-client errors)
- `log('warn', ...)` — called for client errors (auth, validation, rate limit)

---

## Type System

All types live in `src/types.ts`. The file is structured in layers:

### Env Interface

The `Env` interface is the contract between the worker code and Cloudflare's runtime bindings. Every binding declared in `wrangler.toml` must have a matching property here:

```typescript
interface Env {
  RATE_LIMIT_KV: KVNamespace;        // KV binding
  RATE_LIMITER_MINUTE: RateLimit;    // Native rate limiter binding
  ENVIRONMENT: string;               // var from wrangler.toml
  API_KEY: string;                   // secret
  AWS_ACCESS_KEY_ID: string;         // secret
  AWS_SECRET_ACCESS_KEY: string;     // secret
  AWS_REGION: string;                // var from wrangler.toml
  DEFAULT_FROM_EMAIL: string;        // secret
  DEFAULT_FROM_NAME: string;         // secret
  MESSAGECENTRAL_CUSTOMER_ID: string;// secret
  MESSAGECENTRAL_KEY: string;        // secret
  MESSAGECENTRAL_EMAIL: string;      // secret
  MESSAGECENTRAL_COUNTRY_CODE?: string; // optional secret
  ALLOWED_ORIGINS?: string;          // secret (wrangler secret put ALLOWED_ORIGINS)
}
```

### Internal vs External Types

- `SendEmailRequest` — the shape of the JSON body a caller sends to `POST /send`
- `EmailMessage` — the internal normalised form passed to `EmailEngine` and `SESProvider`. Always has `to` as `string[]` (never `string | string[]`).
- `ProviderResponse` — what `SESProvider.send()` returns to `EmailEngine`
- `SendEmailResponse` — the JSON shape returned to the caller

The transformation chain is:
```
raw JSON body
  → SendEmailRequest  (after validateSendEmailRequest)
  → EmailMessage      (after EmailEngine.buildMessage)
  → ProviderResponse  (from SESProvider.send)
  → SendEmailResponse (assembled in handleSend)
```

### MessageCentral API Types

`MessageCentralSendResponse` and `MessageCentralVerifyResponse` model the exact JSON shape returned by the CPAAS v3 API. The `responseCode` field (not HTTP status) is the primary signal — the HTTP response from MessageCentral is always 200; error conditions are encoded in `responseCode`.

---

## Cloudflare Bindings

Defined in `wrangler.toml` and typed in `Env`:

### KV Namespace — RATE_LIMIT_KV

Used for two purposes:
1. Hourly and daily rate limit counters for email sending
2. Idempotency key cache for `POST /send`

Key patterns:
```
rate:hour:<apiKey>:<hourBucket>    TTL: 7200s
rate:day:<apiKey>:<dayBucket>      TTL: 172800s
idem:<idempotencyKey>              TTL: 86400s (24h)
```

### Native Rate Limiter — RATE_LIMITER_MINUTE

Cloudflare's built-in rate limiting API. Configured in `wrangler.toml`:
```toml
[[ratelimits]]
name = "RATE_LIMITER_MINUTE"
namespace_id = "10030"
simple = { limit = 20, period = 60 }
```

Called as `env.RATE_LIMITER_MINUTE.limit({ key: apiKey })`. Returns `{ success: boolean }`. Atomic and distributed — enforced consistently across all CF edge nodes handling this worker.

### Observability

```toml
[observability]
enabled = true
```

Enables Cloudflare's built-in Workers observability, which captures request metrics, error rates, and CPU time in the Cloudflare dashboard without any additional instrumentation.

---

## Design Decisions & Trade-offs

### Single shared API key

The worker is intentionally single-tenant. All callers (SkillPassport, future services) share one `API_KEY`. This simplifies operations — no key rotation per caller, no key management UI needed. The trade-off is that a leaked key grants access to all callers. If per-caller isolation becomes necessary, `auth.ts` is the right place to introduce a key-to-tenant map.

### EmailEngine instance caching

`handleSend` caches the `EmailEngine` instance in module-level variables (`cachedEngine`, `cachedRegion`, `cachedAccessKey`). This avoids re-initialising `AwsClient` (which sets up the signing context) on every request within the same isolate lifetime. The cache is invalidated if `AWS_REGION` or `AWS_ACCESS_KEY_ID` changes, which handles credential rotation without a worker redeploy.

### Raw MIME email vs. SES template API

`SESProvider` builds a raw MIME email and sends it via the `Content.Raw` path of the SES v2 API rather than using SES templates or the structured `Content.Simple` path. This gives full control over headers (custom `Message-ID`, `Reply-To`, `Cc`) and encoding (RFC 2047 for non-ASCII display names), at the cost of more complex email construction code.

### OTP rate limiting in-memory vs. KV

OTP rate limiting uses an in-memory `Map` rather than KV. The trade-off:
- Pro: zero latency, no KV cost per OTP request
- Con: not shared across isolate instances — a user could hit different isolates and bypass the limit

This is acceptable because MessageCentral enforces its own rate limits server-side (response code 800). The in-memory limiter is a first-line defence against obvious abuse within a single isolate, not a hard security boundary.

### Exponential backoff with jitter

The retry delay formula in `EmailEngine`:
```
delay = min(500ms * 2^attempt, 3000ms) ± 25% jitter
```

The 3-second ceiling (`RETRY.MAX_DELAY_MS`) is a hard constraint: with 3 attempts and a max 3-second delay each, the worst-case total retry time is ~9 seconds, well within the 30-second CF Worker CPU limit. The ±25% jitter prevents thundering herd if multiple workers retry simultaneously after a SES blip.

### Text fallback from HTML

If the caller omits the `text` field, `SESProvider` generates a plain-text fallback by stripping HTML tags with a regex. This is intentionally naive — it works for transactional emails but will produce poor output for complex marketing templates. Callers sending rich HTML should always provide an explicit `text` field.

### Header injection prevention

All values inserted into MIME headers pass through `sanitizeHeader()`, which strips `\r`, `\n`, `,`, `<`, `>`. This prevents header injection attacks where a malicious `subject` or `from` value could inject additional MIME headers into the email.

### `cf-ray` as request ID

The `cf-ray` header is Cloudflare's globally unique request identifier, present on all requests that pass through Cloudflare's network. Using it as the `requestId` means log entries can be correlated with Cloudflare's own request logs and the `X-Request-Id` response header the client receives — without generating a separate UUID for most requests.
